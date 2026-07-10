import { createHash } from 'node:crypto';

import {
  RATE_WINDOW_MS,
  shouldSurface,
} from '../agent/suppressor.mjs';
import {
  ATTENTION_CATEGORY_BODY_CUE,
  admit as admitAttentionBudget,
} from '../agent/attention-budget.mjs';
import {
  boundPacketFields,
  buildViewPacket,
  validateViewPacket,
} from '../agent/view-packet.mjs';
import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';

export const BODY_LIVE_SOURCE = 'cs-k';
export const BODY_LIVE_NO_SIGNAL = 'no_live_signal';
export const BODY_LIVE_NO_CUE = 'no_cue_earned';
export const BODY_LIVE_BUDGET_QUEUED = 'attention_budget_queued';
export const BODY_LIVE_PACKET_MODULE = 'body-live';
export const BODY_INTERVENTION_FEEDBACK_KIND = 'BodyInterventionFeedbackRecord';
export const BODY_INTERVENTION_FEEDBACK_ACTIONS = Object.freeze(['accept', 'dismiss', 'cooldown']);

const LOW_HRV_MS = 40;
const SEVERE_HRV_MS = 25;
const MIN_HRV_BASELINE_SAMPLES = 3;
const MIN_HRV_DROP_RATIO = 0.2;
const SEVERE_HRV_DROP_RATIO = 0.4;
const LOW_ATTENTION_SCORE = 0.35;
const SEVERE_ATTENTION_SCORE = 0.12;

const HRV_PATHS = Object.freeze([
  ['hrv_ms'],
  ['hrvMs'],
  ['hrv'],
  ['rmssd_ms'],
  ['rmssdMs'],
  ['rmssd'],
  ['instant_hrv_ms'],
  ['instantHrvMs'],
  ['physiology', 'hrv'],
  ['signals', 'hrv_ms'],
  ['signals', 'hrvMs'],
  ['signals', 'hrv'],
]);

const ATTENTION_PATHS = Object.freeze([
  ['attention_score'],
  ['attentionScore'],
  ['attention_value'],
  ['attentionValue'],
  ['attention'],
  ['attention', 'score'],
  ['attention', 'value'],
  ['eeg_attention'],
  ['eegAttention'],
  ['eeg', 'attention'],
  ['eeg', 'attention_score'],
  ['eeg', 'attentionScore'],
  ['signals', 'attention'],
  ['signals', 'attention_score'],
  ['signals', 'attentionScore'],
]);

const SIGNAL_QUALITY_PATHS = Object.freeze([
  ['signal_quality'],
  ['signalQuality'],
  ['signal_confidence'],
  ['signalConfidence'],
  ['quality'],
  ['eeg', 'signal_quality'],
  ['eeg', 'signalQuality'],
  ['eeg', 'signal_confidence'],
  ['eeg', 'signalConfidence'],
  ['eeg', 'quality'],
  ['signals', 'signal_quality'],
  ['signals', 'signalQuality'],
  ['signals', 'signal_confidence'],
  ['signals', 'signalConfidence'],
]);

const CUE_CONFIDENCE_PATHS = Object.freeze([
  ['confidence'],
  ['cue_confidence'],
  ['cueConfidence'],
  ['cue', 'confidence'],
]);

const CUE_RELEVANCE_PATHS = Object.freeze([
  ['relevance'],
  ['cue_relevance'],
  ['cueRelevance'],
  ['cue', 'relevance'],
]);

export function createBodyLiveState() {
  return {
    lastSurfacedAt: undefined,
    surfacedAt: [],
  };
}

export function bodyLiveCueResponse(payload, options = {}) {
  const generatedAt = isoDate(options.now);
  const state = isPlainObject(options.state) ? options.state : undefined;
  const signals = bodyLiveSignals(payload);
  const surfaceDecision = (reason) => Object.freeze({ surface: false, reason });

  if (!signals) {
    return silencedBodyLiveResponse({
      reason: BODY_LIVE_NO_SIGNAL,
      surfaceDecision: surfaceDecision(BODY_LIVE_NO_SIGNAL),
      generatedAt,
    });
  }

  const candidate = selectBodyLiveCandidate(signals, {
    baselines: options.baselines,
  });

  if (!candidate) {
    return silencedBodyLiveResponse({
      reason: BODY_LIVE_NO_CUE,
      surfaceDecision: surfaceDecision(BODY_LIVE_NO_CUE),
      generatedAt,
      observed: signalSummary(signals),
    });
  }

  const decision = shouldSurface({
    relevance: candidate.relevance,
    confidence: candidate.confidence,
    attention: signals.gateAttention,
    lastSurfacedAt: state?.lastSurfacedAt,
    surfacedCountThisHour: surfacedCountThisHour(state, generatedAt),
    now: generatedAt,
    critical: candidate.critical,
  });

  if (!decision.surface) {
    return silencedBodyLiveResponse({
      reason: decision.reason,
      surfaceDecision: decision,
      generatedAt,
      cue: projectCue(candidate),
      observed: signalSummary(signals),
    });
  }

  const attentionBudget = bodyAttentionBudgetDecision(candidate, signals, {
    ...options,
    generatedAt,
  });
  if (attentionBudget?.queued) {
    return silencedBodyLiveResponse({
      reason: BODY_LIVE_BUDGET_QUEUED,
      surfaceDecision: Object.freeze({
        surface: false,
        reason: BODY_LIVE_BUDGET_QUEUED,
      }),
      generatedAt,
      cue: projectCue(candidate),
      observed: signalSummary(signals),
      attentionBudget,
    });
  }

  const packet = buildBodyLivePacket(candidate, signals, {
    generatedAt,
    surfaceDecision: decision,
  });
  rememberSurfaced(state, generatedAt);

  return stripUndefined({
    ok: true,
    silenced: false,
    surfaceDecision: decision,
    cue: projectCue(candidate),
    packet,
    packets: [packet],
    generatedAt,
    source: BODY_LIVE_SOURCE,
    attentionBudget: visibleAttentionBudget(attentionBudget),
  });
}

export function bodyLiveSignals(payload) {
  if (!isPlainObject(payload)) return null;

  const hrv = firstFiniteAtPath(payload, HRV_PATHS);
  const attentionScore = normalizeScore(firstFiniteAtPath(payload, ATTENTION_PATHS));
  const signalQuality = normalizeScore(firstFiniteAtPath(payload, SIGNAL_QUALITY_PATHS));
  const cueConfidence = normalizeScore(firstFiniteAtPath(payload, CUE_CONFIDENCE_PATHS));
  const cueRelevance = normalizeScore(firstFiniteAtPath(payload, CUE_RELEVANCE_PATHS));
  const eventAt = optionalIso(firstValue(
    payload.eventAt,
    payload.event_at,
    payload.timestamp,
    payload.createdAt,
    payload.created_at,
    payload.validFrom,
    payload.valid_from,
  ));
  const source = sourceForPayload(payload);

  if (
    hrv === undefined &&
    attentionScore === undefined
  ) {
    return null;
  }

  return stripUndefined({
    hrv,
    attentionScore,
    signalQuality,
    cueConfidence,
    cueRelevance,
    gateAttention: gateAttentionForPayload(payload),
    explicitCritical: booleanish(payload.critical ?? payload.cue?.critical),
    inMotion: booleanish(payload.inMotion ?? payload.in_motion ?? payload.context?.inMotion),
    eventAt,
    source,
  });
}

export function selectBodyLiveCandidate(signals, options = {}) {
  const candidates = [
    hrvCueCandidate(signals, options.baselines),
    attentionCueCandidate(signals),
  ].filter(Boolean);

  if (candidates.length === 0) return null;

  return candidates.sort(compareCandidates)[0];
}

function hrvCueCandidate(signals, baselines = {}) {
  const hrv = finiteNumber(signals?.hrv);
  if (hrv === undefined || hrv <= 0) return null;

  const baseline = finiteNumber(baselines?.hrv);
  const samples = Math.max(0, Math.floor(finiteNumber(baselines?.samples) ?? 0));
  const hasBaseline = baseline !== undefined && baseline > 0 && samples >= MIN_HRV_BASELINE_SAMPLES;
  const dropRatio = hasBaseline ? Math.max(0, (baseline - hrv) / baseline) : undefined;
  const acuteLow = hrv <= LOW_HRV_MS;
  const meaningfulDrop = hasBaseline && dropRatio >= MIN_HRV_DROP_RATIO;
  const severe = hrv <= SEVERE_HRV_MS || (hasBaseline && dropRatio >= SEVERE_HRV_DROP_RATIO);

  if (!acuteLow && !meaningfulDrop) return null;

  const evidenceRelevance = clamp01(
    0.68 +
    (acuteLow ? 0.08 : 0) +
    (dropRatio ?? 0) * 0.65 +
    (severe ? 0.06 : 0),
  );
  const evidenceConfidence = clamp01(hasBaseline
    ? 0.82 + Math.min(samples, 12) * 0.01 + Math.min(dropRatio ?? 0, 0.5) * 0.18
    : acuteLow
      ? 0.86
      : 0.7);
  const relevance = cappedBySignal(evidenceRelevance, signals.cueRelevance);
  const confidence = cappedBySignal(
    cappedByQuality(evidenceConfidence, signals.signalQuality),
    signals.cueConfidence,
  );

  return stripUndefined({
    kind: 'hrv_drop',
    signal: 'hrv',
    text: 'Body cue: HRV is below its recent pattern. Consider a two-minute downshift before the next demanding move.',
    action: 'Pause briefly and choose the smallest next move.',
    relevance,
    confidence,
    critical: signals.explicitCritical === true || severe,
    hrvMs: round(hrv, 1),
    baselineHrvMs: hasBaseline ? round(baseline, 1) : undefined,
    hrvDropRatio: dropRatio === undefined ? undefined : round(dropRatio, 3),
  });
}

function attentionCueCandidate(signals) {
  const score = finiteNumber(signals?.attentionScore);
  if (score === undefined || score > LOW_ATTENTION_SCORE) return null;

  const depth = clamp01((LOW_ATTENTION_SCORE - score) / LOW_ATTENTION_SCORE);
  const severe = score <= SEVERE_ATTENTION_SCORE;
  const evidenceRelevance = clamp01(0.72 + depth * 0.22 + (severe ? 0.04 : 0));
  const evidenceConfidence = clamp01(0.84 + depth * 0.1 + (severe ? 0.03 : 0));
  const relevance = cappedBySignal(evidenceRelevance, signals.cueRelevance);
  const confidence = cappedBySignal(
    cappedByQuality(evidenceConfidence, signals.signalQuality),
    signals.cueConfidence,
  );

  return stripUndefined({
    kind: 'attention_dip',
    signal: 'attention',
    text: 'Attention cue: attention has dipped. Consider a short reset before continuing.',
    action: 'Reset briefly, then resume with one concrete next action.',
    relevance,
    confidence,
    critical: signals.explicitCritical === true || severe,
    attentionScore: round(score, 3),
  });
}

function buildBodyLivePacket(candidate, signals, { generatedAt, surfaceDecision }) {
  return validateViewPacket(buildViewPacket({
    viewType: 'generic.card',
    text: candidate.text,
    fields: boundPacketFields(stripUndefined({
      status: 'interrupt',
      interruptionClass: 'ambient',
      cueKind: candidate.kind,
      signal: candidate.signal,
      advisoryOnly: true,
      interrupt: true,
      generatedAt,
      eventAt: signals.eventAt,
      source: signals.source,
      inMotion: signals.inMotion,
      hrvMs: candidate.hrvMs,
      baselineHrvMs: candidate.baselineHrvMs,
      hrvDropRatio: candidate.hrvDropRatio,
      attentionScore: candidate.attentionScore,
      signalQuality: signals.signalQuality,
      relevance: round(candidate.relevance, 3),
      confidence: round(candidate.confidence, 3),
      critical: candidate.critical,
    })),
    action: {
      kind: 'next_action',
      target: candidate.action,
      tag: '[advise]',
    },
    confidence: candidate.confidence,
    surfaceDecision,
    provenance: {
      surface: 'body',
      lane: 'ambient',
      plane: 'body',
      module: BODY_LIVE_PACKET_MODULE,
    },
    frontierExcluded: true,
  }));
}

function bodyAttentionBudgetDecision(candidate, signals, options = {}) {
  if (!shouldApplyAttentionBudget(options)) return undefined;
  const budget = admitAttentionBudget({
    category: ATTENTION_CATEGORY_BODY_CUE,
    id: bodyLiveCueBudgetId(candidate, signals, options.generatedAt),
    cueKind: candidate.kind,
    title: candidate.text,
    text: candidate.text,
    source: signals.source,
    score: candidate.relevance * candidate.confidence,
    rankScore: candidate.relevance * candidate.confidence,
    relevance: candidate.relevance,
    confidence: candidate.confidence,
    eventAt: signals.eventAt ?? options.generatedAt,
    createdAt: options.generatedAt,
  }, {
    dataDir: options.dataDir,
    now: () => new Date(options.generatedAt),
    env: options.env,
    caps: options.attentionBudgetCaps,
    logger: options.logger,
  });

  return stripUndefined({
    status: budget.status,
    category: budget.category,
    cap: budget.cap,
    spent: budget.spent,
    queued: budget.queued,
    queuedUntil: budget.queuedUntil,
    failSoft: budget.failSoft,
    path: budget.path,
  });
}

function shouldApplyAttentionBudget(options = {}) {
  return Boolean(
    options.dataDir ||
    options.env ||
    options.attentionBudgetCaps ||
    options.attentionBudget === true
  ) && options.attentionBudget !== false;
}

function visibleAttentionBudget(attentionBudget) {
  return attentionBudget?.queued || attentionBudget?.failSoft ? attentionBudget : undefined;
}

function bodyLiveCueBudgetId(candidate, signals, generatedAt) {
  return `bodycue_${createHash('sha256').update(stableJson({
    kind: candidate.kind,
    signal: candidate.signal,
    eventAt: signals.eventAt ?? generatedAt,
    source: signals.source,
    hrvMs: candidate.hrvMs,
    attentionScore: candidate.attentionScore,
  })).digest('hex').slice(0, 24)}`;
}

export function bodyInterventionFeedbackRecord(payload, options = {}) {
  if (!isPlainObject(payload)) {
    throw new Error('invalid_feedback_payload');
  }

  const action = normalizeFeedbackAction(
    payload.action ??
      payload.feedback ??
      payload.decision ??
      payload.status,
  );
  const interventionId = optionalString(
    payload.interventionId ??
      payload.intervention_id ??
      payload.cueId ??
      payload.cue_id ??
      payload.packetId ??
      payload.packet_id,
  );
  if (!interventionId) throw new Error('missing_intervention_id');

  const eventAt = optionalIso(firstValue(
    payload.eventAt,
    payload.event_at,
    payload.timestamp,
    payload.createdAt,
    payload.created_at,
  )) ?? isoDate(options.now);
  const receivedAt = isoDate(options.now);
  const packetId = optionalString(payload.packetId ?? payload.packet_id);
  const source = sourceForPayload(payload);
  const cooldownMinutes = action === 'cooldown'
    ? positiveFinite(payload.cooldownMinutes ?? payload.cooldown_minutes ?? payload.minutes)
    : undefined;
  const cooldownUntil = action === 'cooldown'
    ? optionalIso(firstValue(payload.cooldownUntil, payload.cooldown_until, payload.until))
    : undefined;

  const record = stripUndefined({
    kind: BODY_INTERVENTION_FEEDBACK_KIND,
    schemaVersion: 1,
    interventionId: boundText(interventionId, 160),
    action,
    eventAt,
    receivedAt,
    packetId: packetId ? boundText(packetId, 160) : undefined,
    cueKind: optionalString(payload.cueKind ?? payload.cue_kind),
    source,
    cooldownMinutes,
    cooldownUntil,
    reason: boundOptionalText(payload.reason ?? payload.note, 500),
  });

  return Object.freeze({
    id: bodyInterventionFeedbackId(record),
    ...record,
  });
}

function silencedBodyLiveResponse({
  reason,
  surfaceDecision,
  generatedAt,
  cue,
  observed,
  attentionBudget,
}) {
  return stripUndefined({
    ok: true,
    silenced: true,
    reason,
    surfaceDecision,
    cue,
    observed,
    packets: [],
    generatedAt,
    source: BODY_LIVE_SOURCE,
    attentionBudget,
  });
}

function projectCue(candidate) {
  if (!candidate) return undefined;
  return stripUndefined({
    kind: candidate.kind,
    signal: candidate.signal,
    relevance: round(candidate.relevance, 3),
    confidence: round(candidate.confidence, 3),
    critical: candidate.critical,
  });
}

function signalSummary(signals) {
  return stripUndefined({
    hrvMs: signals.hrv === undefined ? undefined : round(signals.hrv, 1),
    attentionScore: signals.attentionScore === undefined ? undefined : round(signals.attentionScore, 3),
    gateAttention: signals.gateAttention,
    source: signals.source,
    eventAt: signals.eventAt,
  });
}

function compareCandidates(a, b) {
  return (
    Number(b.critical) - Number(a.critical) ||
    b.relevance * b.confidence - a.relevance * a.confidence ||
    b.confidence - a.confidence ||
    b.relevance - a.relevance
  );
}

function surfacedCountThisHour(state, now) {
  if (!isPlainObject(state) || !Array.isArray(state.surfacedAt)) return 0;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return 0;

  state.surfacedAt = state.surfacedAt.filter((value) => {
    const atMs = new Date(value).getTime();
    return Number.isFinite(atMs) && nowMs - atMs < RATE_WINDOW_MS;
  });
  return state.surfacedAt.length;
}

function rememberSurfaced(state, generatedAt) {
  if (!isPlainObject(state)) return;
  if (!Array.isArray(state.surfacedAt)) state.surfacedAt = [];
  state.lastSurfacedAt = generatedAt;
  state.surfacedAt.push(generatedAt);
}

function cappedByQuality(confidence, quality) {
  if (quality === undefined) return confidence;
  return Math.min(confidence, clamp01(0.58 + quality * 0.42));
}

function cappedBySignal(evidence, supplied) {
  if (supplied === undefined) return evidence;
  return Math.min(evidence, supplied);
}

function gateAttentionForPayload(payload) {
  const value = firstString(
    payload.gateAttention,
    payload.gate_attention,
    payload.attentionState,
    payload.attention_state,
    payload.userAttention,
    payload.user_attention,
    payload.focusState,
    payload.focus_state,
    payload.context?.gateAttention,
    payload.context?.attentionState,
    payload.context?.attention_state,
    typeof payload.attention === 'string' ? payload.attention : undefined,
  )?.toLowerCase();

  if (!value) return 'neutral';
  if (value.includes('focus')) return 'focus';
  if (value.includes('deep')) return 'focus';
  return 'neutral';
}

function sourceForPayload(payload) {
  const source = firstString(
    payload.source,
    payload.surface,
    payload.provider,
    payload.origin,
    payload.provenance?.surface,
  )?.toLowerCase();

  if (!source) return 'body';
  if (source.includes('eeg') || source.includes('neurosity')) return 'eeg';
  if (source.includes('whoop')) return 'whoop';
  if (source.includes('healthkit') || source.includes('health_kit') || source.includes('apple')) {
    return 'healthkit';
  }
  return source.slice(0, 80);
}

function firstFiniteAtPath(object, paths) {
  for (const path of paths) {
    const value = valueAtPath(object, path);
    const number = finiteNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function valueAtPath(object, path) {
  let current = object;
  for (const key of path) {
    if (!isPlainObject(current) || current[key] === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function finiteNumber(value) {
  if (typeof value === 'boolean') return undefined;
  if (typeof value === 'string' && !optionalString(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeScore(value) {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  if (number >= 0 && number <= 1) return number;
  if (number > 1 && number <= 100) return number / 100;
  return undefined;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function normalizeFeedbackAction(value) {
  const action = optionalString(value)?.toLowerCase().replace(/[-\s]+/g, '_');
  if (action === 'accepted' || action === 'accept') return 'accept';
  if (action === 'dismissed' || action === 'dismiss') return 'dismiss';
  if (action === 'cooldown' || action === 'cooled_down' || action === 'snooze' || action === 'snoozed') {
    return 'cooldown';
  }
  throw new Error('invalid_feedback_action');
}

function positiveFinite(value) {
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return Math.round(number * 1000) / 1000;
}

function optionalIso(value) {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date
    ? value
    : typeof value === 'number'
      ? new Date(value > 1_000_000_000_000 ? value : value * 1000)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoDate(value) {
  const raw = typeof value === 'function' ? value() : value;
  const date = raw instanceof Date ? raw : new Date(raw ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function booleanish(value) {
  if (typeof value === 'boolean') return value;
  const text = optionalString(value)?.toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function bodyInterventionFeedbackId(record) {
  return `bodyfb_${createHash('sha256')
    .update([
      record.kind,
      record.interventionId,
      record.action,
      record.eventAt,
      record.packetId ?? '',
      record.cooldownMinutes ?? '',
      record.cooldownUntil ?? '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 16)}`;
}

function boundOptionalText(value, maxChars) {
  const text = optionalString(value);
  return text ? boundText(text, maxChars) : undefined;
}

function boundText(value, maxChars) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars).trim();
}
