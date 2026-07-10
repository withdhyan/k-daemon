import {
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';

const SURFACES = Object.freeze(['whoop', 'healthkit', 'body']);

const META_KEYS = new Set([
  'id',
  'uuid',
  'event_id',
  'eventId',
  'sample_id',
  'sampleId',
  'source_id',
  'sourceId',
  'source',
  'surface',
  'provider',
  'origin',
  'provenance_surface',
  'provenanceSurface',
  'requested_output',
  'requestedOutput',
  'timestamp',
  'event_at',
  'eventAt',
  'valid_from',
  'validFrom',
  'created_at',
  'createdAt',
  'start_date',
  'startDate',
  'end_date',
  'endDate',
  'in_motion',
  'inMotion',
]);

const EVENT_ARRAY_KEYS = Object.freeze(['events', 'samples', 'measurements', 'data', 'signals']);
const NESTED_EVENT_KEYS = Object.freeze(['telemetry', 'meal', 'sleep']);

const MEASUREMENT_DEFS = Object.freeze([
  {
    canonical: 'hrv',
    keys: ['hrv', 'hrv_ms', 'hrvMs', 'rmssd', 'rmssd_ms', 'rmssdMs', 'heartRateVariability', 'heart_rate_variability'],
    label: 'HRV',
    unit: 'ms',
    physiology: 'hrv',
  },
  {
    canonical: 'respiratoryRate',
    keys: ['rr', 'respiratory_rate', 'respiratoryRate', 'respiration_rate', 'respirationRate', 'breaths_per_minute'],
    label: 'RR',
  },
  {
    canonical: 'heartRate',
    keys: ['heart_rate', 'heartRate', 'bpm', 'resting_heart_rate', 'restingHeartRate'],
    label: 'HR',
    unit: 'bpm',
  },
  {
    canonical: 'recoveryScore',
    keys: ['recovery', 'recovery_score', 'recoveryScore', 'whoop_recovery', 'whoopRecovery'],
    label: 'recovery',
  },
  {
    canonical: 'strain',
    keys: ['strain', 'day_strain', 'dayStrain', 'whoop_strain', 'whoopStrain'],
    label: 'strain',
  },
  {
    canonical: 'spo2',
    keys: ['spo2', 'spO2', 'oxygen_saturation', 'oxygenSaturation'],
    label: 'SpO2',
    unit: '%',
  },
  {
    canonical: 'steps',
    keys: ['steps', 'step_count', 'stepCount'],
    label: 'steps',
  },
  {
    canonical: 'bodyTemperature',
    keys: ['temperature', 'body_temperature', 'bodyTemperature', 'skin_temperature', 'skinTemperature'],
    label: 'temperature',
  },
  {
    canonical: 'alpha',
    keys: ['alpha'],
    label: 'alpha',
    physiology: 'alpha',
  },
  {
    canonical: 'complexity',
    keys: ['complexity'],
    label: 'complexity',
    physiology: 'complexity',
  },
  {
    canonical: 'oneOverF',
    keys: ['one_over_f', 'oneOverF', '1/f'],
    label: '1/f',
    physiology: 'oneOverF',
  },
  {
    canonical: 'sleepDuration',
    keys: ['sleep_duration', 'sleepDuration', 'duration', 'duration_minutes', 'durationMinutes'],
    label: 'sleep duration',
    unit: 'min',
  },
  {
    canonical: 'sleepScore',
    keys: ['sleep_score', 'sleepScore'],
    label: 'sleep score',
  },
  {
    canonical: 'sleepEfficiency',
    keys: ['sleep_efficiency', 'sleepEfficiency'],
    label: 'sleep efficiency',
    unit: '%',
  },
  {
    canonical: 'deepSleep',
    keys: ['deep_sleep', 'deepSleep', 'deep_sleep_minutes', 'deepSleepMinutes'],
    label: 'deep sleep',
    unit: 'min',
  },
  {
    canonical: 'remSleep',
    keys: ['rem_sleep', 'remSleep', 'rem_sleep_minutes', 'remSleepMinutes'],
    label: 'REM sleep',
    unit: 'min',
  },
  {
    canonical: 'awakeDuration',
    keys: ['awake', 'awake_minutes', 'awakeMinutes', 'awake_duration', 'awakeDuration'],
    label: 'awake',
    unit: 'min',
  },
  {
    canonical: 'calories',
    keys: ['calories', 'kcal', 'energy'],
    label: 'calories',
    unit: 'kcal',
  },
  {
    canonical: 'protein',
    keys: ['protein', 'protein_g', 'protein_grams', 'proteinGrams'],
    label: 'protein',
    unit: 'g',
  },
  {
    canonical: 'carbs',
    keys: ['carbs', 'carbohydrates', 'carbohydrate_g', 'carbs_g', 'carbs_grams', 'carbGrams'],
    label: 'carbs',
    unit: 'g',
  },
  {
    canonical: 'fat',
    keys: ['fat', 'fat_g', 'fat_grams', 'fatGrams'],
    label: 'fat',
    unit: 'g',
  },
  {
    canonical: 'fiber',
    keys: ['fiber', 'fiber_g', 'fiberGrams'],
    label: 'fiber',
    unit: 'g',
  },
  {
    canonical: 'sugar',
    keys: ['sugar', 'sugar_g', 'sugarGrams'],
    label: 'sugar',
    unit: 'g',
  },
  {
    canonical: 'water',
    keys: ['water', 'water_ml', 'waterMl', 'hydration_ml', 'hydrationMl'],
    label: 'water',
    unit: 'ml',
  },
  {
    canonical: 'caffeine',
    keys: ['caffeine', 'caffeine_mg', 'caffeineMg'],
    label: 'caffeine',
    unit: 'mg',
  },
  {
    canonical: 'alcohol',
    keys: ['alcohol', 'alcohol_g', 'alcoholGrams'],
    label: 'alcohol',
    unit: 'g',
  },
]);

const DEFS_BY_KEY = new Map(
  MEASUREMENT_DEFS.flatMap((definition) =>
    definition.keys.map((key) => [normalizeKey(key), definition])),
);

const MEASUREMENT_KEY_HINT =
  /(hrv|heart|resp|sleep|calorie|kcal|protein|carb|fat|fiber|glucose|weight|vo2|spo2|oxygen|steps|strain|recovery|temperature|temp|bpm|macro|water|hydration|caffeine|alcohol|sodium|sugar)/i;

export function biosignalFootprintSampleInput(payload, options = {}) {
  if (!isPlainObject(payload)) return null;

  const extracted = extractMeasurements(payload);
  if (Object.keys(extracted.measurements).length === 0) return null;

  const surface = normalizeSurface(
    options.surface ??
      payload.surface ??
      payload.source ??
      payload.provider ??
      payload.origin ??
      payload.provenance_surface ??
      payload.provenanceSurface,
  );
  const report = requiredString(
    `${reportPrefix(options.kind)}: ${extracted.reportParts.join(', ')}`,
    'phenomenology.report',
  );
  const sourceId = firstOptionalString(
    payload.sourceId,
    payload.source_id,
    payload.sampleId,
    payload.sample_id,
    payload.eventId,
    payload.event_id,
    payload.uuid,
    payload.id,
  );
  const eventAt = optionalIso(
    payload.eventAt ??
      payload.event_at ??
      payload.timestamp ??
      payload.validFrom ??
      payload.valid_from ??
      payload.startDate ??
      payload.start_date ??
      payload.createdAt ??
      payload.created_at,
  );
  const inMotion = booleanish(payload.inMotion ?? payload.in_motion);

  return stripUndefined({
    sourceId,
    sampleId: sourceId,
    eventAt,
    provenance: {
      surface,
      lane: 'ambient',
    },
    phenomenology: {
      rung: 'body',
      instrument: 'biosignal',
      report,
    },
    physiology: extracted.physiology,
    context: {
      surface,
      inMotion,
    },
    outcome: stripUndefined({
      category: optionalString(options.kind),
      requestedOutput: optionalString(payload.requested_output ?? payload.requestedOutput),
      measurements: extracted.measurements,
    }),
  });
}

export function biosignalFootprintSampleInputs(payload, options = {}) {
  const events = bodyEvents(payload);
  if (Number.isInteger(options.maxEvents) && events.length > options.maxEvents) {
    return {
      samples: [],
      skippedCount: 0,
      eventCount: events.length,
      tooManyEvents: true,
    };
  }

  const samples = [];
  let skippedCount = 0;

  for (const event of events) {
    try {
      const sample = biosignalFootprintSampleInput(event, options);
      if (sample) {
        samples.push(sample);
      } else {
        skippedCount += 1;
      }
    } catch {
      skippedCount += 1;
    }
  }

  return { samples, skippedCount, eventCount: events.length, tooManyEvents: false };
}

function bodyEvents(payload) {
  if (Array.isArray(payload)) return payload.flatMap((event) => expandBodyEvent(event));
  if (!isPlainObject(payload)) return [payload];

  for (const key of EVENT_ARRAY_KEYS) {
    if (Array.isArray(payload[key])) {
      return payload[key].flatMap((event) => expandBodyEvent(event, payload));
    }
  }

  return expandBodyEvent(payload);
}

function expandBodyEvent(payload, parent = undefined) {
  if (!isPlainObject(payload)) return [payload];

  if (payload.kind !== undefined && payload.value !== undefined) {
    return [signalValueEvent(payload, parent)];
  }

  for (const key of NESTED_EVENT_KEYS) {
    if (isPlainObject(payload[key])) {
      return expandBodyEvent(payload[key], payload);
    }
  }

  return [mergeEventContext(parent, payload)];
}

function signalValueEvent(payload, parent) {
  const kind = optionalString(payload.kind);
  if (!kind) return mergeEventContext(parent, payload);

  return mergeEventContext(parent, {
    ...payload,
    [kind]: payload.value,
    timestamp:
      payload.ended_at ??
      payload.endedAt ??
      payload.timestamp ??
      payload.started_at ??
      payload.startedAt,
  });
}

function mergeEventContext(parent, payload) {
  if (!isPlainObject(parent)) return payload;

  return stripUndefined({
    event_type: parent.event_type,
    eventType: parent.eventType,
    source: parent.source,
    surface: parent.surface,
    provider: parent.provider,
    origin: parent.origin,
    provenance_surface: parent.provenance_surface,
    provenanceSurface: parent.provenanceSurface,
    requested_output: parent.requested_output,
    requestedOutput: parent.requestedOutput,
    timestamp: parent.timestamp,
    ...payload,
  });
}

function extractMeasurements(payload) {
  const measurements = {};
  const physiology = {};
  const reportParts = [];
  const seen = new Set();

  for (const [key, value] of Object.entries(payload)) {
    if (!usableScalar(value)) continue;

    const definition = DEFS_BY_KEY.get(normalizeKey(key));
    if (definition) {
      const numericValue = numericMeasurement(value);
      if (numericValue === undefined) continue;
      addMeasurement({ definition, key, value: numericValue, measurements, physiology, reportParts, seen });
      continue;
    }

    if (!META_KEYS.has(key) && typeof value === 'number' && MEASUREMENT_KEY_HINT.test(key)) {
      const canonical = normalizeKey(key);
      addMeasurement({
        definition: {
          canonical,
          label: humanizeKey(key),
        },
        key,
        value,
        measurements,
        physiology,
        reportParts,
        seen,
      });
    }
  }

  return { measurements, physiology, reportParts };
}

function addMeasurement({ definition, value, measurements, physiology, reportParts, seen }) {
  if (seen.has(definition.canonical)) return;
  seen.add(definition.canonical);

  measurements[definition.canonical] = value;
  if (definition.physiology && typeof value === 'number' && Number.isFinite(value)) {
    physiology[definition.physiology] = value;
  }

  reportParts.push(formatMeasurement(definition, value));
}

function formatMeasurement(definition, value) {
  const rendered = typeof value === 'number' ? formatNumber(value) : String(value).trim();
  return `${definition.label} ${rendered}${definition.unit ?? ''}`;
}

function normalizeSurface(value) {
  const text = optionalString(value)?.toLowerCase();
  if (!text) return 'body';
  if (text.includes('whoop')) return 'whoop';
  if (text.includes('healthkit') || text.includes('health_kit') || text.includes('apple')) {
    return 'healthkit';
  }
  if (SURFACES.includes(text)) return text;
  return 'body';
}

function reportPrefix(kind) {
  switch (optionalString(kind)) {
    case 'sleep':
      return 'sleep signal';
    case 'nutrition':
      return 'nutrition signal';
    default:
      return 'biosignal';
  }
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

function booleanish(value) {
  if (typeof value === 'boolean') return value;
  const text = optionalString(value)?.toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function usableScalar(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Boolean(optionalString(value));
  if (typeof value === 'boolean') return true;
  return false;
}

function numericMeasurement(value) {
  if (typeof value === 'boolean') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function humanizeKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
