import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';

const SURFACES = Object.freeze(['healthkit', 'whoop', 'body']);
const EVENT_ARRAY_KEYS = Object.freeze(['vitals', 'samples', 'records', 'events', 'data']);
const VITAL_KINDS = Object.freeze(['hrv', 'sleep', 'recovery']);

const FIELD_DEFS = Object.freeze({
  hrv: [
    {
      canonical: 'hrvMs',
      keys: ['hrv', 'hrv_ms', 'hrvMs', 'rmssd', 'rmssd_ms', 'rmssdMs', 'heartRateVariability', 'heart_rate_variability', 'value'],
      unit: 'ms',
    },
    {
      canonical: 'sdnnMs',
      keys: ['sdnn', 'sdnn_ms', 'sdnnMs'],
      unit: 'ms',
    },
    {
      canonical: 'restingHeartRate',
      keys: ['resting_heart_rate', 'restingHeartRate', 'rhr', 'heart_rate', 'heartRate', 'bpm'],
      unit: 'bpm',
    },
  ],
  sleep: [
    {
      canonical: 'durationMinutes',
      keys: ['sleep_duration', 'sleepDuration', 'duration', 'duration_minutes', 'durationMinutes', 'sleep_duration_minutes', 'asleep_minutes', 'asleepMinutes', 'value'],
      unit: 'min',
    },
    {
      canonical: 'sleepScore',
      keys: ['sleep_score', 'sleepScore', 'score'],
    },
    {
      canonical: 'sleepEfficiency',
      keys: ['sleep_efficiency', 'sleepEfficiency', 'efficiency'],
    },
    {
      canonical: 'deepSleepMinutes',
      keys: ['deep_sleep', 'deepSleep', 'deep_sleep_minutes', 'deepSleepMinutes'],
      unit: 'min',
    },
    {
      canonical: 'remSleepMinutes',
      keys: ['rem_sleep', 'remSleep', 'rem_sleep_minutes', 'remSleepMinutes'],
      unit: 'min',
    },
    {
      canonical: 'awakeMinutes',
      keys: ['awake', 'awake_minutes', 'awakeMinutes', 'awake_duration', 'awakeDuration'],
      unit: 'min',
    },
  ],
  recovery: [
    {
      canonical: 'recoveryScore',
      keys: ['recovery', 'recovery_score', 'recoveryScore', 'whoop_recovery', 'whoopRecovery', 'score', 'value'],
    },
    {
      canonical: 'hrvMs',
      keys: ['hrv', 'hrv_ms', 'hrvMs', 'rmssd', 'rmssd_ms', 'rmssdMs'],
      unit: 'ms',
    },
    {
      canonical: 'restingHeartRate',
      keys: ['resting_heart_rate', 'restingHeartRate', 'rhr', 'heart_rate', 'heartRate', 'bpm'],
      unit: 'bpm',
    },
    {
      canonical: 'strain',
      keys: ['strain', 'day_strain', 'dayStrain', 'whoop_strain', 'whoopStrain'],
    },
  ],
});

const DEFS_BY_KIND_AND_KEY = new Map(
  Object.entries(FIELD_DEFS).flatMap(([kind, definitions]) =>
    definitions.flatMap((definition) =>
      definition.keys.map((key) => [`${kind}:${normalizeKey(key)}`, definition])),
  ),
);

const INFER_KIND_KEYS = Object.freeze({
  hrv: ['hrv', 'hrv_ms', 'hrvMs', 'rmssd', 'rmssd_ms', 'rmssdMs', 'heartRateVariability'],
  sleep: ['sleep_duration', 'sleepDuration', 'sleep_score', 'sleepScore', 'sleep_efficiency', 'deep_sleep', 'rem_sleep'],
  recovery: ['recovery', 'recovery_score', 'recoveryScore', 'whoop_recovery', 'strain', 'day_strain'],
});

export function bodyVitalRecordInputs(payload, options = {}) {
  const consent = bodyVitalConsent(payload);
  if (!consent) {
    return {
      samples: [],
      skippedCount: 0,
      eventCount: 0,
      tooManyEvents: false,
      missingConsent: true,
    };
  }

  const events = bodyVitalEvents(payload);
  if (Number.isInteger(options.maxEvents) && events.length > options.maxEvents) {
    return {
      samples: [],
      skippedCount: 0,
      eventCount: events.length,
      tooManyEvents: true,
      missingConsent: false,
    };
  }

  const samples = [];
  let skippedCount = 0;

  for (const event of events) {
    try {
      const sample = bodyVitalRecordInput(event, { ...options, consent });
      if (sample) {
        samples.push(sample);
      } else {
        skippedCount += 1;
      }
    } catch {
      skippedCount += 1;
    }
  }

  return {
    samples,
    skippedCount,
    eventCount: events.length,
    tooManyEvents: false,
    missingConsent: false,
  };
}

export function bodyVitalRecordInput(payload, options = {}) {
  if (!isPlainObject(payload)) return null;

  const vitalKind = normalizeVitalKind(
    options.vitalKind ??
      payload.vitalKind ??
      payload.vital_kind ??
      payload.kind ??
      payload.type ??
      payload.recordKind ??
      payload.record_kind ??
      inferVitalKind(payload),
  );
  if (!vitalKind) return null;

  const measurements = extractMeasurements(payload, vitalKind);
  if (Object.keys(measurements).length === 0) return null;

  const units = measurementUnits(vitalKind, measurements, payload.unit ?? payload.units);
  const surface = normalizeSurface(
    options.surface ??
      payload.surface ??
      payload.source ??
      payload.provider ??
      payload.origin ??
      payload.provenance_surface ??
      payload.provenanceSurface,
  );
  const sourceId = firstOptionalString(
    payload.sourceId,
    payload.source_id,
    payload.sampleId,
    payload.sample_id,
    payload.sourceRecordId,
    payload.source_record_id,
    payload.uuid,
    payload.id,
  );
  const startAt = optionalIso(payload.startAt ?? payload.start_at ?? payload.startDate ?? payload.start_date);
  const endAt = optionalIso(payload.endAt ?? payload.end_at ?? payload.endDate ?? payload.end_date);
  const eventAt = optionalIso(
    payload.eventAt ??
      payload.event_at ??
      payload.timestamp ??
      payload.date ??
      payload.endedAt ??
      payload.ended_at ??
      endAt ??
      startAt,
  );
  const ingestedAt = optionalIso(payload.ingestedAt ?? payload.ingested_at);
  const quality = qualityFields(payload);
  const consent = options.consent ?? bodyVitalConsent(payload);
  if (!consent) return null;

  return stripUndefined({
    vitalKind,
    sourceId,
    sampleId: sourceId,
    eventAt,
    validFrom: startAt ?? eventAt,
    ingestedAt,
    startAt,
    endAt,
    provenance: {
      surface,
      lane: 'ambient',
    },
    measurements,
    units,
    quality,
    consent,
    metadata: stripUndefined({
      sourceType: firstOptionalString(payload.sourceType, payload.source_type, payload.recordKind, payload.record_kind),
      requestedOutput: firstOptionalString(payload.requestedOutput, payload.requested_output),
    }),
  });
}

export function bodyVitalConsent(payload) {
  if (!isPlainObject(payload)) return null;

  const rawConsent = payload.consent;
  if (rawConsent === true || payload.off_phone_consent === true || payload.offPhoneConsent === true) {
    return consentRecord(payload);
  }

  if (isPlainObject(rawConsent)) {
    const granted =
      rawConsent.offPhone === true ||
      rawConsent.off_phone === true ||
      rawConsent.off_phone_consent === true ||
      rawConsent.vitals === true;
    if (granted) {
      return consentRecord({
        ...payload,
        consent_scope: rawConsent.scope ?? payload.consent_scope,
        consent_granted_at: rawConsent.grantedAt ?? rawConsent.granted_at ?? payload.consent_granted_at,
      });
    }
  }

  return null;
}

function bodyVitalEvents(payload) {
  if (!isPlainObject(payload)) return [payload];

  for (const key of EVENT_ARRAY_KEYS) {
    if (Array.isArray(payload[key])) {
      return payload[key].map((event) => mergeEventContext(payload, event));
    }
  }

  return [payload];
}

function mergeEventContext(parent, payload) {
  if (!isPlainObject(parent) || !isPlainObject(payload)) return payload;

  return stripUndefined({
    source: parent.source,
    surface: parent.surface,
    provider: parent.provider,
    origin: parent.origin,
    provenance_surface: parent.provenance_surface,
    provenanceSurface: parent.provenanceSurface,
    requested_output: parent.requested_output,
    requestedOutput: parent.requestedOutput,
    ingested_at: parent.ingested_at,
    ingestedAt: parent.ingestedAt,
    ...payload,
  });
}

function extractMeasurements(payload, vitalKind) {
  const measurements = {};
  for (const [key, value] of Object.entries(payload)) {
    const definition = DEFS_BY_KIND_AND_KEY.get(`${vitalKind}:${normalizeKey(key)}`);
    if (!definition) continue;

    const number = numericMeasurement(value);
    if (number === undefined) continue;
    if (measurements[definition.canonical] === undefined) {
      measurements[definition.canonical] = number;
    }
  }
  return measurements;
}

function measurementUnits(vitalKind, measurements, rawUnits) {
  const units = {};
  const unitMap = isPlainObject(rawUnits) ? rawUnits : {};
  const scalarUnit = isPlainObject(rawUnits) ? undefined : optionalString(rawUnits);
  for (const definition of FIELD_DEFS[vitalKind] ?? []) {
    if (measurements[definition.canonical] === undefined) continue;
    const unit = optionalString(unitMap[definition.canonical]) ?? scalarUnit ?? definition.unit;
    if (unit) units[definition.canonical] = unit;
  }
  return units;
}

function qualityFields(payload) {
  return stripUndefined({
    ...(isPlainObject(payload.quality) ? payload.quality : {}),
    referenceWindowValid: booleanish(payload.reference_window_valid ?? payload.referenceWindowValid),
    windowValid: booleanish(payload.window_valid ?? payload.windowValid),
    confidence: numericMeasurement(payload.confidence),
    reason: firstOptionalString(payload.reason, payload.quality_reason, payload.qualityReason),
  });
}

function inferVitalKind(payload) {
  if (hasAnyKey(payload, INFER_KIND_KEYS.sleep)) return 'sleep';
  if (hasAnyKey(payload, INFER_KIND_KEYS.recovery)) return 'recovery';
  if (hasAnyKey(payload, INFER_KIND_KEYS.hrv)) return 'hrv';
  return undefined;
}

function normalizeVitalKind(value) {
  const text = optionalString(value)?.toLowerCase();
  if (!text) return undefined;
  if (text.includes('sleep')) return 'sleep';
  if (text.includes('recover') || text.includes('readiness')) return 'recovery';
  if (text.includes('hrv') || text.includes('rmssd') || text.includes('sdnn') || text.includes('variability')) return 'hrv';
  return VITAL_KINDS.includes(text) ? text : undefined;
}

function consentRecord(payload) {
  return stripUndefined({
    offPhone: true,
    scope: firstOptionalString(payload.consent_scope, payload.consentScope) ?? 'body:vitals',
    grantedAt: optionalIso(payload.consent_granted_at ?? payload.consentGrantedAt),
  });
}

function normalizeSurface(value) {
  const text = optionalString(value)?.toLowerCase();
  if (!text) return 'body';
  if (text.includes('healthkit') || text.includes('health_kit') || text.includes('apple')) {
    return 'healthkit';
  }
  if (text.includes('whoop')) return 'whoop';
  if (SURFACES.includes(text)) return text;
  return 'body';
}

function hasAnyKey(payload, keys) {
  if (!isPlainObject(payload)) return false;
  const normalized = new Set(Object.keys(payload).map(normalizeKey));
  return keys.some((key) => normalized.has(normalizeKey(key)));
}

function numericMeasurement(value) {
  if (typeof value === 'boolean') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanish(value) {
  if (typeof value === 'boolean') return value;
  const text = optionalString(value)?.toLowerCase();
  if (!text) return undefined;
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return undefined;
}

function optionalIso(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? undefined : value.toISOString();

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (Number.isNaN(parsed.valueOf())) return undefined;
    return parsed.toISOString();
  }

  const text = optionalString(value);
  if (!text) return undefined;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return undefined;
  return parsed.toISOString();
}

function firstOptionalString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}
