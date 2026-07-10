import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const RECORD_KINDS = Object.freeze([
  'Exposure',
  'SelfPattern',
  'LearningRecord',
  'FootprintSample',
  'AdminBandish',
  'Bandish',
  'CapacityBudget',
  'KDecision',
  // VitalRecord — crown-jewel body data; explicit-kind reads only.
  'VitalRecord',
  // GenomicTrait — crown-jewel genomic data; never gathered into a frontier prompt (KTD9).
  'GenomicTrait',
]);

export const FRONTIER_EXCLUDED_KINDS = Object.freeze(['VitalRecord', 'GenomicTrait']);

export const EXPOSURE_TYPES = Object.freeze([
  'hypothesis',
  'question',
  'directive',
  'observation',
  'preference',
  'reference',
]);

export const CAPTURE_LANES = Object.freeze(['deliberate', 'ambient']);

export const REVERSIBILITY_CLASSES = Object.freeze([
  'internal-revertible',
  'internal-compensable',
  'external-cancelable',
  'external-compensable',
  'irreversible',
]);

export const ADMIN_BANDISH_TYPES = Object.freeze([
  'TimeSensitive',
  'RegularQueue',
  'Recurring',
]);

export const ADMIN_BANDISH_EFFORTS = Object.freeze([
  'Quick',
  'Hour',
  'Hours',
]);

export const CADENCE_BANDISH_TYPES = Object.freeze([
  'work',
  'meal',
  'sleep',
  'meditation',
  'workout',
  'routine',
  'ops',
]);

const REVERSIBILITY_CLASS_ALIASES = Object.freeze({
  reversible: 'internal-revertible',
  consequential: 'external-compensable',
});

const BANDISH_WHY_MAX_CHARS = 200;
const BANDISH_DETAIL_MAX_BYTES = 2048;

export function normalizeReversibilityClass(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  if (!text) return undefined;
  const normalized = REVERSIBILITY_CLASS_ALIASES[text] ?? text;
  return REVERSIBILITY_CLASSES.includes(normalized) ? normalized : undefined;
}

export function reversibilityRequiresHumanGate(value) {
  const normalized = normalizeReversibilityClass(value);
  return normalized !== undefined && normalized !== 'internal-revertible';
}
export const ATTENTION_MODES = Object.freeze([
  'diverge',
  'converge',
  'breakthrough',
  'operative',
  'physical',
  'restore',
]);

export const RINGS = Object.freeze([
  'core',
  'middle',
  'outer',
]);

const KIND_DIR = Object.freeze({
  Exposure: 'exposures',
  SelfPattern: 'self-patterns',
  LearningRecord: 'learning-records',
  FootprintSample: 'footprint-samples',
  AdminBandish: 'admin-bandish',
  Bandish: 'bandish',
  CapacityBudget: 'capacity-budgets',
  KDecision: 'decisions',
  VitalRecord: 'vital-records',
  GenomicTrait: 'genomic-traits',
});

const KIND_PREFIX = Object.freeze({
  Exposure: 'exp',
  SelfPattern: 'self',
  LearningRecord: 'learn',
  FootprintSample: 'foot',
  AdminBandish: 'admin',
  Bandish: 'bandish',
  CapacityBudget: 'cap',
  KDecision: 'kdec',
  VitalRecord: 'vital',
  GenomicTrait: 'gene',
});

const DEFAULT_SCHEMA_VERSION = 1;
const VITAL_RECORD_KINDS = Object.freeze(['hrv', 'sleep', 'recovery']);

export function createSubstrateStore(options = {}) {
  return new SubstrateStore(options);
}

export class SubstrateStore {
  #dedupeIndex = new Map();

  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.rootDir = path.join(this.dataDir, 'substrate');
    this.now = options.now ?? (() => new Date());
  }

  async writeExposure(input, options = {}) {
    const record = buildExposureRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeFootprintSample(input, options = {}) {
    const record = buildFootprintSampleRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeVitalRecord(input, options = {}) {
    const record = buildVitalRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeGenomicTrait(input, options = {}) {
    const record = buildGenomicTraitRecord(input, this.now());
    const existing = await this.#findLiveByDedupeKey(record.kind, record.dedupeKey);
    if (!existing) {
      await this.#writeRecord(record);
      return writeResult({ record, created: true }, options);
    }

    if (existing.genotype === record.genotype) {
      return writeResult({ record: existing, created: false }, options);
    }

    const { newRecord } = await this.supersedeRecord(existing.id, input);
    return writeResult({ record: newRecord, created: true }, options);
  }

  async processEngagement(input, options = {}) {
    const record = await this.#buildSelfPatternRecord(input);
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeLearningRecord(input, options = {}) {
    const record = buildLearningRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeAdminBandish(input, options = {}) {
    const record = buildAdminBandishRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeBandish(input, options = {}) {
    const record = buildBandishRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async writeCapacityBudget(input, options = {}) {
    const record = buildCapacityBudgetRecord(input, this.now());
    const existing = await this.#findLiveCapacityBudget(record.day, record.attentionMode);
    if (!existing) {
      await this.#writeRecord(record);
      return writeResult({ record, created: true }, options);
    }

    if (existing.dedupeKey === record.dedupeKey) {
      return writeResult({ record: existing, created: false }, options);
    }

    const { newRecord } = await this.supersedeRecord(existing.id, {
      ...input,
      provenance: input.provenance ?? existing.provenance,
    });
    return writeResult({ record: newRecord, created: true }, options);
  }

  async writeKDecision(input, options = {}) {
    const record = buildKDecisionRecord(input, this.now());
    return writeResult(await this.#putByDedupe(record), options);
  }

  async markKDecisionActed(id, options = {}) {
    const record = await this.readRecord(requiredString(id, 'id'));
    if (!record) {
      throw new Error(`record not found: ${id}`);
    }
    if (record.kind !== 'KDecision') {
      throw new Error(`record is not a KDecision: ${id}`);
    }

    if (record.acted === 'acted' && optionalString(record.actedAt)) {
      return writeResult({ record, acted: false }, options);
    }

    const actedAt = toIso(options.at ?? this.now(), 'actedAt');
    const acted = {
      ...record,
      acted: 'acted',
      actedAt,
    };
    await this.#writeRecord(acted);
    return writeResult({ record: acted, acted: true }, options);
  }

  async retireRecord(id, options = {}) {
    const record = await this.readRecord(requiredString(id, 'id'));
    if (!record) {
      throw new Error(`record not found: ${id}`);
    }

    if (!this.#isLiveRecord(record)) {
      return writeResult({ record, retired: false }, options);
    }

    const retired = {
      ...record,
      validTo: toIso(options.at ?? this.now(), 'at'),
    };
    await this.#writeRecord(retired);
    return writeResult({ record: retired, retired: true }, options);
  }

  async supersedeExposure(oldId, replacementInput, options = {}) {
    return this.supersedeRecord(oldId, replacementInput, options);
  }

  async supersedeRecord(oldId, replacementInput, options = {}) {
    const oldRecord = await this.readRecord(requiredString(oldId, 'oldId'));
    if (!oldRecord) {
      throw new Error(`record not found: ${oldId}`);
    }

    if (oldRecord.supersededById) {
      return {
        oldRecord,
        newRecord: await this.readRecord(oldRecord.supersededById),
      };
    }

    const newRecord = await this.#writeReplacement(oldRecord, replacementInput);
    if (newRecord.id === oldRecord.id) {
      return { oldRecord, newRecord };
    }

    const retired = {
      ...oldRecord,
      validTo: toIso(options.at ?? this.now(), 'at'),
      supersededById: newRecord.id,
    };
    await this.#writeRecord(retired);

    return { oldRecord: retired, newRecord };
  }

  async readRecord(id) {
    const recordId = requiredString(id, 'id');
    for (const kind of RECORD_KINDS) {
      const file = path.join(this.#kindDir(kind), `${recordId}.json`);
      try {
        return await readJson(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  async listRecords(kind) {
    const kinds = kind
      ? [assertKind(kind)]
      : RECORD_KINDS.filter((currentKind) => !FRONTIER_EXCLUDED_KINDS.includes(currentKind));
    const records = [];

    for (const currentKind of kinds) {
      const dir = this.#kindDir(currentKind);
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          records.push(await readJson(path.join(dir, entry.name)));
        }
      }
    }

    return records.sort(compareRecords);
  }

  async countRecords(kind) {
    return (await this.listRecords(kind)).length;
  }

  async #writeReplacement(oldRecord, input) {
    const candidate = await this.#buildReplacementRecord(oldRecord.kind, input);
    if (
      oldRecord.kind === 'GenomicTrait' &&
      candidate.dedupeKey === oldRecord.dedupeKey &&
      candidate.id !== oldRecord.id
    ) {
      const replacement = await this.#nonCollidingSameKeyReplacement(oldRecord, candidate);
      await this.#writeRecord(replacement);
      return replacement;
    }

    const result = await this.#putByDedupe(candidate);
    if (!result.created && result.record.id !== oldRecord.id) {
      throw new Error(
        `supersession replacement collides with existing record ${result.record.id}; ` +
          'supersession must create a new record',
      );
    }

    return result.record;
  }

  async #nonCollidingSameKeyReplacement(oldRecord, candidate) {
    const existing = await this.readRecord(candidate.id);
    if (!existing) return candidate;
    if (!existing.validTo && !existing.supersededById) {
      throw new Error(
        `supersession replacement collides with existing record ${existing.id}; ` +
          'supersession must create a new record',
      );
    }

    return {
      ...candidate,
      id: recordId(
        candidate.kind,
        `${candidate.dedupeKey}::replacement::${oldRecord.id}::${candidate.genotype}`,
      ),
    };
  }

  async #buildReplacementRecord(kind, input) {
    switch (kind) {
      case 'Exposure':
        return buildExposureRecord(input, this.now());
      case 'FootprintSample':
        return buildFootprintSampleRecord(input, this.now());
      case 'VitalRecord':
        return buildVitalRecord(input, this.now());
      case 'GenomicTrait':
        return buildGenomicTraitRecord(input, this.now());
      case 'SelfPattern':
        return this.#buildSelfPatternRecord(input);
      case 'LearningRecord':
        return buildLearningRecord(input, this.now());
      case 'AdminBandish':
        return buildAdminBandishRecord(input, this.now());
      case 'Bandish':
        return buildBandishRecord(input, this.now());
      case 'CapacityBudget':
        return buildCapacityBudgetRecord(input, this.now());
      case 'KDecision':
        return buildKDecisionRecord(input, this.now());
      default:
        throw new Error(`unsupported record kind: ${kind}`);
    }
  }

  async #buildSelfPatternRecord(input) {
    const exposure = await this.readRecord(requiredString(input.exposureId, 'exposureId'));
    if (!exposure || exposure.kind !== 'Exposure') {
      throw new Error(`engagement must reference an Exposure: ${input.exposureId}`);
    }

    return buildSelfPatternFromEngagement(input, exposure, this.now());
  }

  async #putByDedupe(record) {
    const existing = await this.#findLiveByDedupeKey(record.kind, record.dedupeKey);
    if (existing) return { record: existing, created: false };

    await this.#writeRecord(record);
    return { record, created: true };
  }

  async #findLiveByDedupeKey(kind, dedupeKey) {
    const index = await this.#dedupeIndexForKind(kind);
    const id = index.get(dedupeKey);
    if (!id) return null;

    let record;
    try {
      record = await readJson(this.#recordPathById(kind, id));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      index.delete(dedupeKey);
      return null;
    }

    if (record.dedupeKey === dedupeKey && this.#isLiveRecord(record)) {
      return record;
    }

    if (index.get(dedupeKey) === id) {
      index.delete(dedupeKey);
    }
    return null;
  }

  async #findLiveCapacityBudget(day, attentionMode) {
    const records = await this.listRecords('CapacityBudget');
    return records
      .filter((record) =>
        this.#isLiveRecord(record) &&
        record.day === day &&
        record.attentionMode === attentionMode)
      .sort((a, b) =>
        (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '') ||
        (b.id ?? '').localeCompare(a.id ?? ''))[0] ?? null;
  }

  async #writeRecord(record) {
    await fs.mkdir(this.#kindDir(record.kind), { recursive: true });
    await fs.writeFile(
      this.#recordPath(record),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    this.#updateDedupeIndex(record);
  }

  async #dedupeIndexForKind(kind) {
    const recordKind = assertKind(kind);
    const cached = this.#dedupeIndex.get(recordKind);
    if (cached) return cached;

    // Invariant: at most one LIVE record per (kind, dedupeKey). We build the
    // index by ingestedAt ascending and let the most-recent live record win —
    // matching the warm-path last-write-wins in #updateDedupeIndex, so a cold
    // rebuild and a warm index can never disagree on the canonical record. If a
    // non-atomic supersession failure or a concurrent same-key write ever leaves
    // two live records on disk, this surfaces it (warn) and resolves it
    // deterministically rather than silently masking one. (The atomicity of
    // supersession itself is a separate, pre-existing concern — see
    // docs/residual-review-findings.)
    const index = new Map();
    const records = (await this.listRecords(recordKind))
      .slice()
      .sort(
        (a, b) =>
          (a.ingestedAt ?? '').localeCompare(b.ingestedAt ?? '') ||
          (a.id ?? '').localeCompare(b.id ?? ''),
      );
    for (const record of records) {
      if (!this.#isLiveRecord(record)) continue;
      if (index.has(record.dedupeKey)) {
        console.warn(
          `[cs-k] substrate: duplicate live ${recordKind} for one dedupeKey — keeping most-recent (non-atomic supersession residue)`,
        );
      }
      index.set(record.dedupeKey, record.id);
    }

    this.#dedupeIndex.set(recordKind, index);
    return index;
  }

  #updateDedupeIndex(record) {
    const index = this.#dedupeIndex.get(record.kind);
    if (!index) return;

    if (this.#isLiveRecord(record)) {
      index.set(record.dedupeKey, record.id);
    } else if (index.get(record.dedupeKey) === record.id) {
      index.delete(record.dedupeKey);
    }
  }

  #isLiveRecord(record) {
    return !record.validTo && !record.supersededById;
  }

  #recordPath(record) {
    return this.#recordPathById(record.kind, record.id);
  }

  #recordPathById(kind, id) {
    return path.join(this.#kindDir(kind), `${id}.json`);
  }

  #kindDir(kind) {
    return path.join(this.rootDir, KIND_DIR[assertKind(kind)]);
  }
}

export function exposureDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  return joinKey([
    'Exposure',
    provenance.surface,
    input.sourceId ?? input.sourceEnvelopeId ?? 'none',
    input.type ?? 'observation',
    input.statement,
  ]);
}

export function footprintSampleDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  const phenomenology = input.phenomenology ?? {};
  const sampleIdentity =
    input.sampleId ?? input.sourceId ?? footprintContentHash(input);
  return joinKey([
    'FootprintSample',
    provenance.surface,
    sampleIdentity,
    input.eventAt ?? input.validFrom ?? '',
    phenomenology.rung ?? 'none',
    phenomenology.report ?? '',
  ]);
}

export function vitalRecordDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  const vitalKind = normalizeVitalKind(input.vitalKind);
  const sampleIdentity =
    input.sampleId ?? input.sourceId ?? input.sourceRecordId ?? vitalContentHash(input);
  return joinKey([
    'VitalRecord',
    provenance.surface,
    vitalKind,
    sampleIdentity,
    input.eventAt ?? input.validFrom ?? '',
  ]);
}

export function genomicTraitDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  // Genotype stays out of the key so each rsid has one live record; changed genotypes supersede.
  return joinKey([
    'GenomicTrait',
    provenance.surface,
    input.rsid,
  ]);
}

function footprintContentHash(input) {
  return createHash('sha256')
    .update(stableJson({
      phenomenology: input.phenomenology ?? {},
      physiology: input.physiology ?? {},
      context: input.context ?? {},
      disconfirmers: input.disconfirmers ?? [],
      outcome: input.outcome ?? {},
    }))
    .digest('hex')
    .slice(0, 24);
}

function vitalContentHash(input) {
  return createHash('sha256')
    .update(stableJson({
      vitalKind: input.vitalKind,
      measurements: input.measurements ?? {},
      units: input.units ?? {},
      quality: input.quality ?? {},
      window: {
        startAt: input.startAt,
        endAt: input.endAt,
      },
      metadata: input.metadata ?? {},
    }))
    .digest('hex')
    .slice(0, 24);
}

function selfPatternDedupeKey(input) {
  return joinKey([
    'SelfPattern',
    input.pattern,
    input.evidenceIds.join('|'),
    input.engagement.action,
    input.engagement.eventAt,
  ]);
}

function learningRecordDedupeKey(input) {
  return joinKey([
    'LearningRecord',
    input.category,
    input.label,
    input.text,
    input.evidenceIds.join('|'),
    input.sourceEntryId ?? 'none',
  ]);
}

export function adminBandishDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  const title = requiredString(input.title, 'title');
  const type = normalizeAdminBandishType(input.type ?? input.adminType);
  const effort = normalizeAdminBandishEffort(input.effort);
  const dates = normalizeAdminBandishDates(input);
  return joinKey([
    'AdminBandish',
    provenance.surface,
    input.sourceId ?? input.sourceRecordId ?? 'content',
    title,
    type,
    effort,
    dates.remindAt,
    dates.dueAt,
  ]);
}

export function bandishDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  const window = normalizeBandishWindow(input);
  const day = normalizeDay(input.day ?? input.date ?? input.dayDate, window.startAt, 'day');
  const attentionMode = normalizeAttentionMode(input.attentionMode ?? input.mode);
  const ring = normalizeRing(input.ring);
  const description = requiredString(
    input.description ?? input.title ?? input.label,
    'description',
  );
  const type = normalizeOptionalBandishType(input.type);
  const why = normalizeOptionalBandishWhy(input.why);
  const detail = normalizeOptionalBandishDetail(input.detail);

  return joinKey([
    'Bandish',
    provenance.surface,
    input.sourceId ?? input.sourceRecordId ?? 'content',
    day,
    window.startAt,
    window.endAt,
    attentionMode,
    ring,
    description,
    type,
    why,
    stableJson(detail),
  ]);
}

export function capacityBudgetDedupeKey(input) {
  const day = normalizeDay(input.day ?? input.date ?? input.dayDate, input.eventAt, 'day');
  const attentionMode = normalizeAttentionMode(input.attentionMode ?? input.mode);
  const minutes = normalizeCapacityMinutes(
    input.minutes ?? input.capacityMinutes ?? input.budgetMinutes,
  );

  return joinKey([
    'CapacityBudget',
    day,
    attentionMode,
    minutes,
  ]);
}

export function kDecisionDedupeKey(input) {
  const provenance = normalizeProvenance(input.provenance);
  const evidence = input.evidence !== undefined ? uniqueStrings(input.evidence) : undefined;
  const evidenceIds = input.evidenceIds !== undefined ? uniqueStrings(input.evidenceIds) : undefined;
  return joinKey([
    'KDecision',
    provenance.surface,
    input.sourceId ?? input.sourceRecordId ?? input.id ?? 'content',
    input.eventAt ?? input.createdAt ?? input.validFrom ?? '',
    input.observation ?? input.decision ?? '',
    input.reasoning ?? input.reason ?? '',
    evidence?.join('|') ?? evidenceIds?.join('|') ?? '',
    input.conclusion ?? input.recommended ?? '',
    input.urgency ?? '',
  ]);
}

function buildExposureRecord(input, now) {
  const type = input.type ?? 'observation';
  if (!EXPOSURE_TYPES.includes(type)) {
    throw new Error(`invalid Exposure type: ${type}`);
  }

  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const statement = requiredString(input.statement, 'statement');
  const dedupeKey = exposureDedupeKey({ ...input, type, statement, provenance });

  return baseRecord({
    kind: 'Exposure',
    dedupeKey,
    temporal,
    provenance,
    body: {
      type,
      statement,
      context: optionalString(input.context),
      sourceId: optionalString(input.sourceId ?? input.sourceEnvelopeId),
      frontierExcluded: input.frontierExcluded === true ? true : undefined,
      metadata: input.metadata == null ? undefined : plainObject(input.metadata),
    },
  });
}

function buildFootprintSampleRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const phenomenology = input.phenomenology ?? {};
  const physiology = input.physiology ?? {};
  const context = input.context ?? {};
  const dedupeKey = footprintSampleDedupeKey({ ...input, provenance });

  return baseRecord({
    kind: 'FootprintSample',
    dedupeKey,
    temporal,
    provenance,
    body: {
      phenomenology: {
        rung: optionalString(phenomenology.rung),
        instrument: optionalString(phenomenology.instrument ?? 'free'),
        report: requiredString(phenomenology.report, 'phenomenology.report'),
        ratings: plainObject(phenomenology.ratings ?? {}),
      },
      physiology: {
        alpha: optionalNumber(physiology.alpha, 'physiology.alpha'),
        complexity: optionalNumber(physiology.complexity, 'physiology.complexity'),
        oneOverF: optionalNumber(physiology.oneOverF ?? physiology['1/f'], 'physiology.oneOverF'),
        hrv: optionalNumber(physiology.hrv, 'physiology.hrv'),
      },
      context: {
        surface: optionalString(context.surface) ?? provenance.surface,
        inMotion: Boolean(context.inMotion),
      },
      disconfirmers: stringArray(input.disconfirmers ?? []),
      outcome: plainObject(input.outcome ?? {}),
    },
  });
}

function buildVitalRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const vitalKind = normalizeVitalKind(input.vitalKind);
  const consent = normalizeVitalConsent(input.consent);
  const temporal = biTemporal(input, now);
  const measurements = finiteNumberObject(input.measurements, 'measurements');
  const dedupeKey = vitalRecordDedupeKey({ ...input, vitalKind, provenance });

  if (Object.keys(measurements).length === 0) {
    throw new Error('measurements must include at least one finite number');
  }

  return baseRecord({
    kind: 'VitalRecord',
    dedupeKey,
    temporal,
    provenance,
    body: {
      frontierExcluded: true,
      vitalKind,
      sourceId: optionalString(input.sourceId ?? input.sourceRecordId),
      sampleId: optionalString(input.sampleId),
      measurements,
      units: stringMap(input.units ?? {}),
      quality: plainObject(input.quality ?? {}),
      window: stripUndefined({
        startAt: optionalString(input.startAt),
        endAt: optionalString(input.endAt),
      }),
      consent,
      metadata: plainObject(input.metadata ?? {}),
    },
  });
}

function buildGenomicTraitRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const rsid = requiredString(input.rsid, 'rsid');
  const genotype = requiredString(input.genotype, 'genotype');
  const dedupeKey = genomicTraitDedupeKey({ ...input, rsid, provenance });

  return baseRecord({
    id: genomicTraitRecordId(dedupeKey, genotype),
    kind: 'GenomicTrait',
    dedupeKey,
    temporal,
    provenance,
    body: {
      rsid,
      chromosome: requiredString(input.chromosome, 'chromosome'),
      position: requiredString(input.position, 'position'),
      genotype,
      trait: requiredString(input.trait, 'trait'),
      category: requiredString(input.category, 'category'),
    },
  });
}

function buildSelfPatternFromEngagement(input, exposure, now) {
  const eventAt = toIso(input.eventAt ?? input.validFrom ?? now, 'eventAt');
  const provenance = normalizeProvenance(input.provenance ?? exposure.provenance);
  const evidenceIds = uniqueStrings([exposure.id, ...(input.evidenceIds ?? [])]);
  const engagement = {
    action: requiredString(input.action ?? input.engagementType ?? 'engaged', 'action'),
    exposureId: exposure.id,
    eventAt,
    note: optionalString(input.note),
  };
  const pattern = requiredString(input.pattern, 'pattern');
  const temporal = biTemporal({ ...input, eventAt }, now);
  const dedupeKey = selfPatternDedupeKey({ pattern, evidenceIds, engagement });

  return baseRecord({
    kind: 'SelfPattern',
    dedupeKey,
    temporal,
    provenance,
    body: {
      pattern,
      evidence: evidenceIds,
      confidence: confidence(input.confidence ?? 0),
      frontierExcluded: input.frontierExcluded === true ? true : undefined,
      derivedFrom: 'engagement',
      engagement,
    },
  });
}

function buildLearningRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const category = requiredString(input.category ?? 'pattern', 'category');
  const text = requiredString(input.text, 'text');
  const label = optionalString(input.label) ?? text.split(/\s+/).slice(0, 8).join(' ');
  const evidenceIds = uniqueStrings(input.evidenceIds ?? []);
  const dedupeKey = learningRecordDedupeKey({
    category,
    label,
    text,
    evidenceIds,
    sourceEntryId: input.sourceEntryId,
  });

  return baseRecord({
    kind: 'LearningRecord',
    dedupeKey,
    temporal,
    provenance,
    body: {
      category,
      label,
      text,
      evidenceIds,
      planId: optionalString(input.planId),
      unitId: optionalString(input.unitId),
      sourceEntryId: optionalString(input.sourceEntryId),
      consent: plainObject(input.consent ?? { state: 'approved' }),
      frontierExcluded: input.frontierExcluded === true ? true : undefined,
    },
  });
}

function buildAdminBandishRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const type = normalizeAdminBandishType(input.type ?? input.adminType);
  const effort = normalizeAdminBandishEffort(input.effort);
  const title = requiredString(input.title, 'title');
  const dates = normalizeAdminBandishDates(input);
  const dedupeKey = adminBandishDedupeKey({
    ...input,
    provenance,
    type,
    effort,
    title,
    ...dates,
  });

  return baseRecord({
    kind: 'AdminBandish',
    dedupeKey,
    temporal,
    provenance,
    body: {
      type,
      effort,
      title,
      note: optionalString(input.note ?? input.description),
      remindAt: dates.remindAt,
      dueAt: dates.dueAt,
      sourceId: optionalString(input.sourceId ?? input.sourceRecordId),
      recurrence: input.recurrence == null ? undefined : plainObject(input.recurrence),
      metadata: input.metadata == null ? undefined : plainObject(input.metadata),
    },
  });
}


function normalizeOptionalBandishSubtasks(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('subtasks must be an array');
  const items = value.slice(0, 24).map((item) => {
    if (typeof item === 'string') return { text: item.trim() };
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      const out = { text: item.text.trim() };
      if (item.timeSensitive === true) out.timeSensitive = true;
      if (item.done === true) out.done = true;
      return out;
    }
    throw new Error('subtask must be a string or {text}');
  }).filter((item) => item.text.length > 0);
  return items.length > 0 ? items : undefined;
}

function buildBandishRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const window = normalizeBandishWindow(input);
  const day = normalizeDay(input.day ?? input.date ?? input.dayDate, window.startAt, 'day');
  const attentionMode = normalizeAttentionMode(input.attentionMode ?? input.mode);
  const ring = normalizeRing(input.ring);
  const description = requiredString(
    input.description ?? input.title ?? input.label,
    'description',
  );
  const title = optionalString(input.title);
  // Additive (2026-07-08): subtasks — per-type block content (work/routine/ops
  // checklists). Array of strings or {text, timeSensitive} objects, ≤24 items.
  const subtasks = normalizeOptionalBandishSubtasks(input.subtasks);
  const type = normalizeOptionalBandishType(input.type);
  const why = normalizeOptionalBandishWhy(input.why);
  const detail = normalizeOptionalBandishDetail(input.detail);
  const dedupeKey = bandishDedupeKey({
    ...input,
    provenance,
    day,
    startAt: window.startAt,
    endAt: window.endAt,
    attentionMode,
    ring,
    description,
    title,
    subtasks,
    type,
    why,
    detail,
  });

  return baseRecord({
    kind: 'Bandish',
    dedupeKey,
    temporal,
    provenance,
    body: {
      day,
      startAt: window.startAt,
      endAt: window.endAt,
      attentionMode,
      ring,
      description,
    title,
    subtasks,
      type,
      why,
      detail,
      sourceId: optionalString(input.sourceId ?? input.sourceRecordId),
      metadata: input.metadata == null ? undefined : plainObject(input.metadata),
    },
  });
}

function buildCapacityBudgetRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const day = normalizeDay(input.day ?? input.date ?? input.dayDate, input.eventAt, 'day');
  const attentionMode = normalizeAttentionMode(input.attentionMode ?? input.mode);
  const minutes = normalizeCapacityMinutes(
    input.minutes ?? input.capacityMinutes ?? input.budgetMinutes,
  );
  const dedupeKey = capacityBudgetDedupeKey({
    ...input,
    day,
    attentionMode,
  });

  return baseRecord({
    kind: 'CapacityBudget',
    dedupeKey,
    temporal,
    provenance,
    body: {
      day,
      attentionMode,
      minutes,
      sourceId: optionalString(input.sourceId ?? input.sourceRecordId),
      metadata: input.metadata == null ? undefined : plainObject(input.metadata),
    },
  });
}

function buildKDecisionRecord(input, now) {
  const provenance = normalizeProvenance(input.provenance);
  const temporal = biTemporal(input, now);
  const evidence = input.evidence !== undefined ? uniqueStrings(input.evidence) : undefined;
  const evidenceIds = input.evidenceIds !== undefined ? uniqueStrings(input.evidenceIds) : undefined;
  const observation = optionalString(input.observation);
  const reasoning = optionalString(input.reasoning);
  const conclusion = optionalString(input.conclusion);
  const decision = optionalString(input.decision);
  const recommended = optionalString(input.recommended);
  const summary = optionalString(input.summary);
  if (!observation && !decision && !conclusion && !recommended && !summary) {
    throw new Error('KDecision requires observation, decision, conclusion, recommended, or summary');
  }

  const dedupeKey = kDecisionDedupeKey({
    ...input,
    provenance,
    observation,
    reasoning,
    evidence,
    evidenceIds,
    conclusion,
    decision,
    recommended,
  });

  return baseRecord({
    kind: 'KDecision',
    dedupeKey,
    temporal,
    provenance,
    body: {
      observation,
      reasoning,
      evidence,
      conclusion,
      confidence: input.confidence !== undefined ? confidence(input.confidence) : undefined,
      urgency: optionalString(input.urgency),
      acted: normalizeKDecisionActed(input.acted),
      actedAt: optionalString(input.actedAt),
      sourceId: optionalString(input.sourceId ?? input.sourceRecordId),

      // Additive legacy LoopRecommendation fields. They stay sparse so old
      // records can be represented without synthesizing the widened fields.
      station: optionalString(input.station),
      date: optionalString(input.date),
      verdict: optionalString(input.verdict),
      advisoryOnly: typeof input.advisoryOnly === 'boolean' ? input.advisoryOnly : undefined,
      decision,
      recommended,
      reason: optionalString(input.reason),
      risk: optionalString(input.risk),
      reversibility: optionalString(input.reversibility),
      undo: optionalString(input.undo),
      evidenceIds,
      tag: optionalString(input.tag),
      summary,
      decisionCard: input.decisionCard == null ? undefined : plainObject(input.decisionCard),
      metadata: input.metadata == null ? undefined : plainObject(input.metadata),
    },
  });
}

function baseRecord({ id, kind, dedupeKey, temporal, provenance, body }) {
  return stripUndefined({
    id: id ?? recordId(kind, dedupeKey),
    kind,
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    dedupeKey,
    validFrom: temporal.validFrom,
    validTo: null,
    eventAt: temporal.eventAt,
    ingestedAt: temporal.ingestedAt,
    supersededById: null,
    provenance,
    ...body,
  });
}

function biTemporal(input, now) {
  const current = now instanceof Date ? now : now();
  const eventAt = toIso(input.eventAt ?? input.validFrom ?? current, 'eventAt');
  return {
    eventAt,
    validFrom: toIso(input.validFrom ?? eventAt, 'validFrom'),
    ingestedAt: toIso(input.ingestedAt ?? current, 'ingestedAt'),
  };
}

function normalizeProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') {
    throw new Error('provenance is required');
  }

  const surface = requiredString(provenance.surface, 'provenance.surface');
  const lane = provenance.lane ?? 'deliberate';
  if (!CAPTURE_LANES.includes(lane)) {
    throw new Error(`invalid provenance.lane: ${lane}`);
  }

  return {
    surface,
    lane,
  };
}

function normalizeVitalKind(value) {
  const kind = requiredString(value, 'vitalKind').toLowerCase();
  if (!VITAL_RECORD_KINDS.includes(kind)) {
    throw new Error(`invalid vitalKind: ${kind}`);
  }
  return kind;
}

function normalizeVitalConsent(value) {
  if (!isPlainObject(value) || value.offPhone !== true) {
    throw new Error('consent.offPhone must be true');
  }

  return stripUndefined({
    offPhone: true,
    scope: optionalString(value.scope),
    grantedAt: optionalString(value.grantedAt),
  });
}

function normalizeAdminBandishType(value) {
  const type = requiredString(value, 'type');
  if (!ADMIN_BANDISH_TYPES.includes(type)) {
    throw new Error(`invalid AdminBandish type: ${type}`);
  }
  return type;
}

function normalizeAdminBandishEffort(value) {
  const effort = requiredString(value, 'effort');
  if (!ADMIN_BANDISH_EFFORTS.includes(effort)) {
    throw new Error(`invalid AdminBandish effort: ${effort}`);
  }
  return effort;
}

function normalizeAdminBandishDates(input) {
  const remindAt = toIso(input.remindAt ?? input.remindDate ?? input.remind, 'remindAt');
  const dueAt = toIso(input.dueAt ?? input.dueDate ?? input.due, 'dueAt');
  if (remindAt === dueAt) {
    throw new Error('remindAt and dueAt must be different dates');
  }
  return { remindAt, dueAt };
}

function normalizeBandishWindow(input) {
  const startAt = toIso(input.startAt ?? input.startsAt ?? input.start, 'startAt');
  const endAt = toIso(input.endAt ?? input.endsAt ?? input.end, 'endAt');
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error('endAt must be after startAt');
  }
  return { startAt, endAt };
}

function normalizeDay(value, fallbackAt, label) {
  const raw = optionalString(value);
  if (raw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return toIso(`${raw}T00:00:00.000Z`, label).slice(0, 10);
    }
    return toIso(raw, label).slice(0, 10);
  }
  if (fallbackAt) return toIso(fallbackAt, label).slice(0, 10);
  throw new Error(`${label} is required`);
}

function normalizeAttentionMode(value) {
  const mode = requiredString(value, 'attentionMode');
  if (!ATTENTION_MODES.includes(mode)) {
    throw new Error(`invalid AttentionMode: ${mode}`);
  }
  return mode;
}

function normalizeRing(value) {
  const ring = requiredString(value, 'ring');
  if (!RINGS.includes(ring)) {
    throw new Error(`invalid Ring: ${ring}`);
  }
  return ring;
}

function normalizeOptionalBandishType(value) {
  const type = optionalString(value);
  if (!type) return undefined;
  if (!CADENCE_BANDISH_TYPES.includes(type)) {
    throw new Error(`invalid Bandish type: ${type}`);
  }
  return type;
}

function normalizeOptionalBandishWhy(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('why must be a string');
  const why = value.trim();
  if (!why) return undefined;
  if (why.length > BANDISH_WHY_MAX_CHARS) {
    throw new Error(`why must be ${BANDISH_WHY_MAX_CHARS} characters or fewer`);
  }
  return why;
}

function normalizeOptionalBandishDetail(value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error('detail must be a plain object');
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('detail must be JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > BANDISH_DETAIL_MAX_BYTES) {
    throw new Error(`detail must be ${BANDISH_DETAIL_MAX_BYTES} bytes or fewer`);
  }
  return JSON.parse(json);
}

function normalizeCapacityMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error('minutes must be a non-negative integer');
  }
  return minutes;
}

function normalizeKDecisionActed(value) {
  if (value === undefined || value === null) return undefined;
  if (value === true) return 'acted';
  if (value === false) return 'pending';
  const text = String(value).trim().toLowerCase();
  if (['pending', 'acted', 'dismissed'].includes(text)) return text;
  throw new Error(`invalid KDecision acted: ${value}`);
}

function recordId(kind, dedupeKey) {
  const hash = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24);
  return `${KIND_PREFIX[assertKind(kind)]}_${hash}`;
}

function genomicTraitRecordId(dedupeKey, genotype) {
  const hash = createHash('sha256')
    .update(`${dedupeKey}::${normalizeKeyPart(genotype)}`)
    .digest('hex')
    .slice(0, 24);
  return `${KIND_PREFIX.GenomicTrait}_${hash}`;
}

function joinKey(parts) {
  return parts.map((part) => normalizeKeyPart(part)).join('::');
}

function normalizeKeyPart(part) {
  return String(part ?? 'none').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function makeLogNote(prefix) {
  const label = requiredString(prefix, 'log note prefix');
  return (notes, logger, message) => {
    notes.push(message);
    if (logger?.warn) logger.warn(`[cs-k] ${label}: ${message}`);
  };
}

function optionalNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function confidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  return number;
}

function stringArray(values) {
  if (!Array.isArray(values)) throw new Error('expected an array of strings');
  return values.map((value) => requiredString(value, 'array item'));
}

function uniqueStrings(values) {
  return [...new Set(stringArray(values))];
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a plain object');
  }
  return { ...value };
}

function finiteNumberObject(value, label) {
  const input = plainObject(value);
  const output = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const number = Number(rawValue);
    if (!Number.isFinite(number)) {
      throw new Error(`${label}.${key} must be a finite number`);
    }
    output[key] = number;
  }
  return output;
}

function stringMap(value) {
  const input = plainObject(value);
  const output = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const text = optionalString(rawValue);
    if (text) output[key] = text;
  }
  return output;
}

function toIso(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date.toISOString();
}

function assertKind(kind) {
  if (!RECORD_KINDS.includes(kind)) {
    throw new Error(`invalid record kind: ${kind}`);
  }
  return kind;
}

function compareRecords(a, b) {
  return (
    a.ingestedAt.localeCompare(b.ingestedAt) ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id)
  );
}

export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== 'object') return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) clean[key] = stripUndefined(child);
  }
  return clean;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}

function writeResult(result, options) {
  return options?.withWriteResult ? result : result.record;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
