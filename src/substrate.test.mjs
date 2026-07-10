import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ADMIN_BANDISH_EFFORTS,
  ADMIN_BANDISH_TYPES,
  ATTENTION_MODES,
  CADENCE_BANDISH_TYPES,
  FRONTIER_EXCLUDED_KINDS,
  REVERSIBILITY_CLASSES,
  RINGS,
  createSubstrateStore,
  normalizeReversibilityClass,
  reversibilityRequiresHumanGate,
} from './substrate.mjs';

const fixedNow = () => new Date('2026-06-27T00:00:00.000Z');

test('reversibility taxonomy normalizes aliases and sets the human-gate floor', () => {
  assert.deepEqual(REVERSIBILITY_CLASSES, [
    'internal-revertible',
    'internal-compensable',
    'external-cancelable',
    'external-compensable',
    'irreversible',
  ]);
  assert.equal(normalizeReversibilityClass('reversible'), 'internal-revertible');
  assert.equal(normalizeReversibilityClass('consequential'), 'external-compensable');
  assert.equal(normalizeReversibilityClass('unknown'), undefined);

  assert.equal(reversibilityRequiresHumanGate('internal-revertible'), false);
  assert.equal(reversibilityRequiresHumanGate('internal-compensable'), true);
  assert.equal(reversibilityRequiresHumanGate('external-cancelable'), true);
  assert.equal(reversibilityRequiresHumanGate('external-compensable'), true);
  assert.equal(reversibilityRequiresHumanGate('irreversible'), true);
});

test('writes an Exposure and reads it back without joining self', async () => {
  const store = await freshStore();

  const exposure = await store.writeExposure({
    type: 'reference',
    statement: 'K should prefer silence unless an action earns surfacing.',
    sourceId: 'bookmark:1',
    eventAt: '2026-06-26T12:00:00.000Z',
    provenance: { surface: 'chrome', lane: 'deliberate' },
  });

  assert.equal(exposure.kind, 'Exposure');
  assert.equal(exposure.type, 'reference');
  assert.equal(exposure.validFrom, '2026-06-26T12:00:00.000Z');
  assert.equal(exposure.validTo, null);
  assert.equal(exposure.supersededById, null);
  assert.equal(exposure.provenance.surface, 'chrome');

  assert.deepEqual(await store.readRecord(exposure.id), exposure);
  assert.deepEqual(await store.listRecords('SelfPattern'), []);
});

test('supersedes an Exposure while keeping the old record present', async () => {
  const store = await freshStore();
  const oldExposure = await store.writeExposure({
    type: 'observation',
    statement: 'A noisy cue should be surfaced.',
    sourceId: 'note:1',
    eventAt: '2026-06-25T10:00:00.000Z',
    provenance: { surface: 'ios', lane: 'ambient' },
  });
  const beforeFiles = await recordFiles(store.dataDir);

  const { oldRecord, newRecord } = await store.supersedeExposure(
    oldExposure.id,
    {
      type: 'observation',
      statement: 'A noisy cue should stay silent unless it passes the wisdom gate.',
      sourceId: 'note:1-revision',
      eventAt: '2026-06-26T10:00:00.000Z',
      provenance: { surface: 'ios', lane: 'ambient' },
    },
    { at: '2026-06-27T09:00:00.000Z' },
  );

  const afterFiles = await recordFiles(store.dataDir);
  const persistedOld = await store.readRecord(oldExposure.id);

  assert.equal(newRecord.kind, 'Exposure');
  assert.equal(oldRecord.id, oldExposure.id);
  assert.equal(persistedOld.id, oldExposure.id);
  assert.equal(
    JSON.stringify(nonTemporalFields(persistedOld)),
    JSON.stringify(nonTemporalFields(oldExposure)),
  );
  assert.equal(persistedOld.statement, oldExposure.statement);
  assert.equal(persistedOld.validTo, '2026-06-27T09:00:00.000Z');
  assert.equal(persistedOld.supersededById, newRecord.id);
  assert.equal((await store.listRecords('Exposure')).length, 2);
  assert.equal(afterFiles.length, beforeFiles.length + 1);
  assert(afterFiles.includes(`${oldExposure.id}.json`));
  assert(afterFiles.includes(`${newRecord.id}.json`));
});

test('re-superseding a retired Exposure returns the existing replacement', async () => {
  const store = await freshStore();
  const oldExposure = await store.writeExposure(exposureInput('a', 'Original exposure A.'));
  const first = await store.supersedeRecord(
    oldExposure.id,
    exposureInput('b', 'Replacement exposure B.'),
    { at: '2026-06-27T09:00:00.000Z' },
  );

  const second = await store.supersedeRecord(
    oldExposure.id,
    exposureInput('c', 'Replacement exposure C must not be written.'),
    { at: '2026-06-28T09:00:00.000Z' },
  );

  assert.equal(second.oldRecord.id, oldExposure.id);
  assert.equal(second.oldRecord.validTo, '2026-06-27T09:00:00.000Z');
  assert.equal(second.oldRecord.supersededById, first.newRecord.id);
  assert.equal(second.newRecord.id, first.newRecord.id);
  assert.equal(second.newRecord.statement, 'Replacement exposure B.');
  assert.equal(await store.countRecords('Exposure'), 2);
});

for (const kind of [
  'Exposure',
  'SelfPattern',
  'FootprintSample',
  'AdminBandish',
  'Bandish',
  'CapacityBudget',
  'KDecision',
  'VitalRecord',
]) {
  test(`superseding a ${kind} rejects replacements that collide with unrelated records`, async () => {
    const store = await freshStore();
    const { oldRecord, existingRecord, replacementInput } =
      await supersessionCollisionFixture(kind, store);

    await assert.rejects(
      store.supersedeRecord(
        oldRecord.id,
        replacementInput,
        { at: '2026-06-27T09:00:00.000Z' },
      ),
      new RegExp(
        `supersession replacement collides with existing record ${escapeRegExp(existingRecord.id)}; ` +
          'supersession must create a new record',
      ),
    );

    const persistedOld = await store.readRecord(oldRecord.id);
    assert.equal(persistedOld.validTo, null);
    assert.equal(persistedOld.supersededById, null);
    assert.notEqual(persistedOld.supersededById, existingRecord.id);
    assert.equal(await store.countRecords(kind), 2);
  });
}

test('dedupe-key makes rewriting the same Exposure idempotent', async () => {
  const store = await freshStore();
  const input = {
    type: 'reference',
    statement: '  The same statement  normalizes   to one record. ',
    sourceId: 'bookmark:dedupe',
    eventAt: '2026-06-26T12:00:00.000Z',
    provenance: { surface: 'chrome', lane: 'deliberate' },
  };

  const first = await store.writeExposure(input);
  const second = await store.writeExposure({
    ...input,
    statement: 'the same statement normalizes to one record.',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.dedupeKey, first.dedupeKey);
  assert.equal((await store.listRecords('Exposure')).length, 1);
  assert.equal((await recordFiles(store.dataDir)).length, 1);
});

test('dedupe index scans a kind once and reuses it for same-kind writes', async (t) => {
  const store = await freshStore();
  const originalReaddir = fs.readdir;
  let exposureReaddirCount = 0;

  t.mock.method(fs, 'readdir', async (...args) => {
    const [dir] = args;
    if (path.basename(String(dir)) === 'exposures') {
      exposureReaddirCount += 1;
    }
    return Reflect.apply(originalReaddir, fs, args);
  });

  const firstInput = exposureInput('index-a', 'The first indexed exposure.');
  const first = await store.writeExposure(firstInput, { withWriteResult: true });
  const second = await store.writeExposure(
    exposureInput('index-b', 'The second indexed exposure.'),
    { withWriteResult: true },
  );
  const duplicate = await store.writeExposure(firstInput, { withWriteResult: true });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(exposureReaddirCount, 1);
});

test('derives a SelfPattern from an engagement event', async () => {
  const store = await freshStore();
  const exposure = await store.writeExposure({
    type: 'directive',
    statement: 'Mute feeds that repeatedly steal attention.',
    sourceId: 'directive:1',
    eventAt: '2026-06-24T09:00:00.000Z',
    provenance: { surface: 'chrome', lane: 'deliberate' },
  });

  const selfPattern = await store.processEngagement({
    exposureId: exposure.id,
    action: 'acted',
    pattern: 'Prefers subtraction over another dashboard.',
    confidence: 0.7,
    eventAt: '2026-06-25T09:00:00.000Z',
    provenance: { surface: 'loop', lane: 'deliberate' },
  });

  assert.equal(selfPattern.kind, 'SelfPattern');
  assert.equal(selfPattern.derivedFrom, 'engagement');
  assert.deepEqual(selfPattern.evidence, [exposure.id]);
  assert.equal(selfPattern.engagement.exposureId, exposure.id);
  assert.equal(selfPattern.provenance.surface, 'loop');
  assert.equal((await store.listRecords('SelfPattern')).length, 1);
  assert.equal(store.writeSelfPattern, undefined);
});

test('processEngagement rejects a missing Exposure reference', async () => {
  const store = await freshStore();

  await assert.rejects(
    store.processEngagement(selfPatternInput('exp_missing', 'missing')),
    /engagement must reference an Exposure/,
  );
  assert.equal(await store.countRecords('SelfPattern'), 0);
});

test('persists a FootprintSample and exposes no hard-delete operation', async () => {
  const store = await freshStore();

  const footprint = await store.writeFootprintSample({
    eventAt: '2026-06-26T06:30:00.000Z',
    provenance: { surface: 'hrv', lane: 'ambient' },
    phenomenology: {
      rung: 'free',
      instrument: 'free',
      report: 'First-person report stays load-bearing.',
      ratings: { clarity: 3 },
    },
    physiology: { hrv: 52, alpha: 0.2 },
    context: { inMotion: true },
    disconfirmers: ['Sleep deprivation would weaken this read.'],
    outcome: { followUp: 'check longitudinal density' },
  });

  assert.equal(footprint.kind, 'FootprintSample');
  assert.equal(footprint.context.surface, 'hrv');
  assert.equal(footprint.context.inMotion, true);
  assert.equal((await store.listRecords('FootprintSample')).length, 1);
  assert.equal(store.deleteRecord, undefined);
  assert.equal(store.destroyRecord, undefined);
});

test('persists a consented VitalRecord as frontier-excluded body data', async () => {
  const store = await freshStore();

  await assert.rejects(
    store.writeVitalRecord({
      vitalKind: 'hrv',
      eventAt: '2026-06-26T06:30:00.000Z',
      provenance: { surface: 'healthkit', lane: 'ambient' },
      measurements: { hrvMs: 42 },
    }),
    /consent\.offPhone must be true/,
  );

  const vital = await store.writeVitalRecord(vitalInput('hrv-a', 42));
  const duplicate = await store.writeVitalRecord(vitalInput('hrv-a', 42));
  const genericRecords = await store.listRecords();
  const vitalRecords = await store.listRecords('VitalRecord');

  assert.equal(vital.kind, 'VitalRecord');
  assert.equal(vital.vitalKind, 'hrv');
  assert.equal(vital.frontierExcluded, true);
  assert.equal(vital.validFrom, '2026-06-26T06:30:00.000Z');
  assert.equal(vital.ingestedAt, fixedNow().toISOString());
  assert.equal(vital.provenance.surface, 'healthkit');
  assert.deepEqual(vital.measurements, { hrvMs: 42 });
  assert.deepEqual(vital.units, { hrvMs: 'ms' });
  assert.deepEqual(vital.consent, {
    offPhone: true,
    scope: 'body:vitals',
  });
  assert.equal(duplicate.id, vital.id);
  assert.equal(vitalRecords.length, 1);
  assert(genericRecords.every((record) => record.kind !== 'VitalRecord'));
});

test('persists an AdminBandish with type, effort, and distinct remind/due dates', async () => {
  const store = await freshStore();

  const admin = await store.writeAdminBandish(adminBandishInput('visa', {
    type: 'TimeSensitive',
    effort: 'Quick',
    title: 'Renew visa',
    remindAt: '2026-09-01',
    dueAt: '2026-09-20',
    note: 'Keep logistics quarantined from cadence.',
  }));
  const duplicate = await store.writeAdminBandish(adminBandishInput('visa', {
    type: 'TimeSensitive',
    effort: 'Quick',
    title: 'Renew visa',
    remindAt: '2026-09-01',
    dueAt: '2026-09-20',
  }));

  assert.deepEqual(ADMIN_BANDISH_TYPES, ['TimeSensitive', 'RegularQueue', 'Recurring']);
  assert.deepEqual(ADMIN_BANDISH_EFFORTS, ['Quick', 'Hour', 'Hours']);
  assert.equal(admin.kind, 'AdminBandish');
  assert.equal(admin.type, 'TimeSensitive');
  assert.equal(admin.effort, 'Quick');
  assert.equal(admin.title, 'Renew visa');
  assert.equal(admin.note, 'Keep logistics quarantined from cadence.');
  assert.equal(admin.remindAt, '2026-09-01T00:00:00.000Z');
  assert.equal(admin.dueAt, '2026-09-20T00:00:00.000Z');
  assert.equal(admin.validFrom, '2026-06-27T00:00:00.000Z');
  assert.equal(admin.provenance.surface, 'admin');
  assert.equal(duplicate.id, admin.id);
  assert.equal((await store.listRecords('AdminBandish')).length, 1);
  assert.deepEqual(await store.readRecord(admin.id), admin);
});

test('AdminBandish rejects invalid enums and matching dual dates', async () => {
  const store = await freshStore();

  await assert.rejects(
    store.writeAdminBandish(adminBandishInput('bad-type', { type: 'Nowish' })),
    /invalid AdminBandish type: Nowish/,
  );
  await assert.rejects(
    store.writeAdminBandish(adminBandishInput('bad-effort', { effort: 'Week' })),
    /invalid AdminBandish effort: Week/,
  );
  await assert.rejects(
    store.writeAdminBandish(adminBandishInput('same-dates', {
      remindAt: '2026-09-20',
      dueAt: '2026-09-20',
    })),
    /remindAt and dueAt must be different dates/,
  );
  assert.equal(await store.countRecords('AdminBandish'), 0);
});

test('persists a Bandish with attention mode, ring, and day window', async () => {
  const store = await freshStore();

  const bandish = await store.writeBandish(bandishInput('deep-work', {
    day: '2026-07-05',
    startAt: '2026-07-05T09:00:00.000Z',
    endAt: '2026-07-05T10:30:00.000Z',
    attentionMode: 'converge',
    ring: 'core',
    description: 'Implement cadence substrate records.',
    type: 'work',
    why: 'the one thing that compounds',
    detail: {
      plan: ['ship substrate fields', 'round-trip projection'],
      energy: 'high',
    },
  }));
  const duplicate = await store.writeBandish(bandishInput('deep-work', {
    day: '2026-07-05',
    startAt: '2026-07-05T09:00:00.000Z',
    endAt: '2026-07-05T10:30:00.000Z',
    attentionMode: 'converge',
    ring: 'core',
    description: 'Implement cadence substrate records.',
    type: 'work',
    why: 'the one thing that compounds',
    detail: {
      plan: ['ship substrate fields', 'round-trip projection'],
      energy: 'high',
    },
  }));
  const readBack = await store.readRecord(bandish.id);

  assert.deepEqual(ATTENTION_MODES, [
    'diverge',
    'converge',
    'breakthrough',
    'operative',
    'physical',
    'restore',
  ]);
  assert.deepEqual(RINGS, ['core', 'middle', 'outer']);
  assert.deepEqual(CADENCE_BANDISH_TYPES, [
    'work',
    'meal',
    'sleep',
    'meditation',
    'workout',
    'routine',
    'ops',
  ]);
  assert.equal(bandish.kind, 'Bandish');
  assert.equal(bandish.day, '2026-07-05');
  assert.equal(bandish.startAt, '2026-07-05T09:00:00.000Z');
  assert.equal(bandish.endAt, '2026-07-05T10:30:00.000Z');
  assert.equal(bandish.attentionMode, 'converge');
  assert.equal(bandish.ring, 'core');
  assert.equal(bandish.description, 'Implement cadence substrate records.');
  assert.equal(bandish.type, 'work');
  assert.equal(bandish.why, 'the one thing that compounds');
  assert.deepEqual(bandish.detail, {
    plan: ['ship substrate fields', 'round-trip projection'],
    energy: 'high',
  });
  assert.equal(bandish.provenance.surface, 'cadence');
  assert.deepEqual(readBack.detail, bandish.detail);
  assert.equal(readBack.why, bandish.why);
  assert.equal(duplicate.id, bandish.id);
  assert.equal((await store.listRecords('Bandish')).length, 1);
});

test('Bandish rejects invalid enums and inverted windows', async () => {
  const store = await freshStore();

  await assert.rejects(
    store.writeBandish(bandishInput('bad-mode', { attentionMode: 'wander' })),
    /invalid AttentionMode: wander/,
  );
  await assert.rejects(
    store.writeBandish(bandishInput('bad-ring', { ring: 'inner' })),
    /invalid Ring: inner/,
  );
  await assert.rejects(
    store.writeBandish(bandishInput('bad-type', { type: 'planning' })),
    /invalid Bandish type: planning/,
  );
  await assert.rejects(
    store.writeBandish(bandishInput('bad-window', {
      endAt: '2026-07-05T08:00:00.000Z',
    })),
    /endAt must be after startAt/,
  );
  assert.equal(await store.countRecords('Bandish'), 0);
});

test('persists one live CapacityBudget per day and attention mode', async () => {
  const store = await freshStore();

  const first = await store.writeCapacityBudget(capacityBudgetInput({
    day: '2026-07-05',
    attentionMode: 'converge',
    minutes: 180,
  }));
  const duplicate = await store.writeCapacityBudget(capacityBudgetInput({
    day: '2026-07-05',
    attentionMode: 'converge',
    minutes: 180,
  }));
  const changed = await store.writeCapacityBudget(capacityBudgetInput({
    day: '2026-07-05',
    attentionMode: 'converge',
    minutes: 210,
  }));
  const records = await store.listRecords('CapacityBudget');
  const live = records.filter((record) => !record.validTo && !record.supersededById);

  assert.equal(first.kind, 'CapacityBudget');
  assert.equal(first.day, '2026-07-05');
  assert.equal(first.attentionMode, 'converge');
  assert.equal(first.minutes, 180);
  assert.equal(duplicate.id, first.id);
  assert.notEqual(changed.id, first.id);
  assert.equal(changed.minutes, 210);
  assert.equal(records.length, 2);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, changed.id);
  assert.equal((await store.readRecord(first.id)).supersededById, changed.id);
});

test('CapacityBudget rejects invalid mode and minutes', async () => {
  const store = await freshStore();

  await assert.rejects(
    store.writeCapacityBudget(capacityBudgetInput({ attentionMode: 'admin' })),
    /invalid AttentionMode: admin/,
  );
  await assert.rejects(
    store.writeCapacityBudget(capacityBudgetInput({ minutes: 1.5 })),
    /minutes must be a non-negative integer/,
  );
  await assert.rejects(
    store.writeCapacityBudget(capacityBudgetInput({ minutes: -1 })),
    /minutes must be a non-negative integer/,
  );
  assert.equal(await store.countRecords('CapacityBudget'), 0);
});

test('persists sparse legacy decision shape and widened KDecision fields additively', async () => {
  const store = await freshStore();

  const legacy = await store.writeKDecision(kDecisionInput('legacy', {
    station: 'decide',
    verdict: 'recommend',
    advisoryOnly: true,
    decision: 'Whether to keep the old decision shape loadable.',
    recommended: 'Keep it loadable.',
    reason: 'Existing records already use decision/recommended/reason.',
    evidenceIds: ['exp_legacy'],
    acted: 'pending',
  }));
  const widened = await store.writeKDecision(kDecisionInput('widened', {
    observation: 'The retro loop has a stale open decision.',
    reasoning: 'A timestamped acted transition makes the signal auditable.',
    evidence: ['exp_signal'],
    conclusion: 'Record acted decisions explicitly.',
    confidence: 0.8,
    urgency: 'act',
    acted: false,
  }));

  assert.equal(legacy.kind, 'KDecision');
  assert.equal(legacy.decision, 'Whether to keep the old decision shape loadable.');
  assert.equal(legacy.recommended, 'Keep it loadable.');
  assert.deepEqual(legacy.evidenceIds, ['exp_legacy']);
  assert.equal(legacy.acted, 'pending');
  assert(!Object.hasOwn(legacy, 'observation'));
  assert(!Object.hasOwn(legacy, 'reasoning'));
  assert(!Object.hasOwn(legacy, 'evidence'));
  assert(!Object.hasOwn(legacy, 'conclusion'));
  assert(!Object.hasOwn(legacy, 'urgency'));
  assert.deepEqual(await store.readRecord(legacy.id), legacy);

  assert.equal(widened.observation, 'The retro loop has a stale open decision.');
  assert.equal(widened.reasoning, 'A timestamped acted transition makes the signal auditable.');
  assert.deepEqual(widened.evidence, ['exp_signal']);
  assert.equal(widened.conclusion, 'Record acted decisions explicitly.');
  assert.equal(widened.confidence, 0.8);
  assert.equal(widened.urgency, 'act');
  assert.equal(widened.acted, 'pending');
  assert.equal(await store.countRecords('KDecision'), 2);
});

test('markKDecisionActed records actedAt on the acted transition', async () => {
  const store = await freshStore();
  const decision = await store.writeKDecision(kDecisionInput('act-me', {
    observation: 'A decision was accepted.',
    conclusion: 'Apply the recommendation.',
    acted: 'pending',
  }));

  const acted = await store.markKDecisionActed(decision.id, {
    at: '2026-06-28T09:15:00.000Z',
    withWriteResult: true,
  });
  const repeated = await store.markKDecisionActed(decision.id, {
    at: '2026-06-29T09:15:00.000Z',
    withWriteResult: true,
  });

  assert.equal(acted.acted, true);
  assert.equal(acted.record.acted, 'acted');
  assert.equal(acted.record.actedAt, '2026-06-28T09:15:00.000Z');
  assert.equal(repeated.acted, false);
  assert.equal(repeated.record.actedAt, '2026-06-28T09:15:00.000Z');
  assert.deepEqual(await store.readRecord(decision.id), acted.record);
});

test('genomic dedupe index follows supersession to the current live record', async () => {
  const store = await freshStore();
  const v1 = await store.writeGenomicTrait(genomicInput('AA'));
  const v2 = await store.writeGenomicTrait(genomicInput('AG'), { withWriteResult: true });
  const duplicateV2 = await store.writeGenomicTrait(
    genomicInput('AG'),
    { withWriteResult: true },
  );
  const records = await store.listRecords('GenomicTrait');
  const matching = records.filter((record) => record.dedupeKey === v1.dedupeKey);
  const live = matching.filter((record) => !record.validTo && !record.supersededById);
  const retiredV1 = matching.find((record) => record.id === v1.id);

  assert.equal(v2.created, true);
  assert.notEqual(v2.record.id, v1.id);
  assert.equal(duplicateV2.created, false);
  assert.equal(duplicateV2.record.id, v2.record.id);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, v2.record.id);
  assert.equal(retiredV1.validTo, '2026-06-27T00:00:00.000Z');
  assert.equal(retiredV1.supersededById, v2.record.id);
});

test('a cold rebuild over a superseded+live pair selects the most-recent live record', async () => {
  const store = await freshStore();
  await store.writeGenomicTrait(genomicInput('AA'));
  const v2 = await store.writeGenomicTrait(genomicInput('AG'), { withWriteResult: true });

  // Reopen over the same dir: forces a cold #dedupeIndex rebuild from disk where
  // both the retired v1 (AA) and the live v2 (AG) share one dedupeKey.
  const reopened = createSubstrateStore({ dataDir: store.dataDir, now: fixedNow });
  const rewrite = await reopened.writeGenomicTrait(genomicInput('AG'), { withWriteResult: true });
  const live = (await reopened.listRecords('GenomicTrait')).filter(
    (record) => !record.validTo && !record.supersededById,
  );

  // Cold rebuild must agree with the warm index: dedupes to v2 (most-recent live),
  // never resurrects the retired v1.
  assert.equal(rewrite.created, false);
  assert.equal(rewrite.record.id, v2.record.id);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, v2.record.id);
});

test('generic record listing excludes frontier-excluded substrate kinds', async () => {
  const store = await freshStore();
  await store.writeExposure(exposureInput('frontier-safe', 'Generic listing may include this.'));
  const vital = await store.writeVitalRecord(vitalInput('frontier-vital', 41));
  const genomic = await store.writeGenomicTrait({
    rsid: 'rs4988235',
    chromosome: '2',
    position: '136608646',
    genotype: 'AG',
    trait: 'LCT lactase persistence',
    category: 'nutrition',
    provenance: { surface: 'genome', lane: 'deliberate' },
  });

  const genericRecords = await store.listRecords();
  const vitalRecords = await store.listRecords('VitalRecord');
  const genomicRecords = await store.listRecords('GenomicTrait');

  assert.deepEqual(FRONTIER_EXCLUDED_KINDS, ['VitalRecord', 'GenomicTrait']);
  assert(genericRecords.every((record) => record.kind !== 'VitalRecord'));
  assert(genericRecords.every((record) => record.kind !== 'GenomicTrait'));
  assert.equal(vitalRecords.length, 1);
  assert.equal(vitalRecords[0].id, vital.id);
  assert.equal(genomicRecords.length, 1);
  assert.equal(genomicRecords[0].id, genomic.id);
});

test('persists distinct FootprintSamples that share eventAt, rung, and report', async () => {
  const store = await freshStore();
  const base = {
    eventAt: '2026-06-26T06:30:00.000Z',
    provenance: { surface: 'hrv', lane: 'ambient' },
    phenomenology: {
      rung: 'free',
      instrument: 'free',
      report: 'The report text is intentionally identical.',
      ratings: { clarity: 3 },
    },
    physiology: { hrv: 52, alpha: 0.2 },
    context: { inMotion: true },
    disconfirmers: ['Same stated disconfirmer.'],
    outcome: { followUp: 'same follow-up' },
  };

  const first = await store.writeFootprintSample(base);
  const duplicate = await store.writeFootprintSample(base);
  const second = await store.writeFootprintSample({
    ...base,
    phenomenology: {
      ...base.phenomenology,
      ratings: { clarity: 4 },
    },
    physiology: { hrv: 61, alpha: 0.4 },
    context: { inMotion: false },
  });

  assert.equal(duplicate.id, first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(await store.countRecords('FootprintSample'), 2);
});

test('direct FootprintSample writes ignore caller-supplied dedupeKey', async () => {
  const store = await freshStore();

  const first = await store.writeFootprintSample({
    ...footprintInput('caller-a', 'First distinct sample.'),
    dedupeKey: 'pin',
  });
  const second = await store.writeFootprintSample({
    ...footprintInput('caller-b', 'Second distinct sample.'),
    dedupeKey: 'pin',
  });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.dedupeKey, 'pin');
  assert.notEqual(second.dedupeKey, 'pin');
  assert.equal(await store.countRecords('FootprintSample'), 2);
});

test('fresh store lazily finds an existing live record by dedupe key', async () => {
  const store = await freshStore();
  const input = exposureInput('fresh-index', 'A fresh store should find this live record.');
  const first = await store.writeExposure(input);
  const reopened = createSubstrateStore({ dataDir: store.dataDir, now: fixedNow });

  const duplicate = await reopened.writeExposure(input, { withWriteResult: true });

  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, first.id);
  assert.equal(await reopened.countRecords('Exposure'), 1);
});

async function supersessionCollisionFixture(kind, store) {
  switch (kind) {
    case 'Exposure':
      return exposureCollisionFixture(store);
    case 'SelfPattern':
      return selfPatternCollisionFixture(store);
    case 'FootprintSample':
      return footprintCollisionFixture(store);
    case 'AdminBandish':
      return adminBandishCollisionFixture(store);
    case 'Bandish':
      return bandishCollisionFixture(store);
    case 'CapacityBudget':
      return capacityBudgetCollisionFixture(store);
    case 'KDecision':
      return kDecisionCollisionFixture(store);
    case 'VitalRecord':
      return vitalCollisionFixture(store);
    default:
      throw new Error(`unsupported fixture kind: ${kind}`);
  }
}

async function exposureCollisionFixture(store) {
  const oldRecord = await store.writeExposure(exposureInput('a', 'Original exposure A.'));
  const replacementInput = exposureInput('b', 'Existing exposure B.');
  const existingRecord = await store.writeExposure(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function selfPatternCollisionFixture(store) {
  const exposureA = await store.writeExposure(exposureInput('self-a', 'Evidence A.'));
  const exposureB = await store.writeExposure(exposureInput('self-b', 'Evidence B.'));
  const oldRecord = await store.processEngagement(selfPatternInput(exposureA.id, 'A'));
  const replacementInput = selfPatternInput(exposureB.id, 'B');
  const existingRecord = await store.processEngagement(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function footprintCollisionFixture(store) {
  const oldRecord = await store.writeFootprintSample(footprintInput('a', 'Original footprint A.'));
  const replacementInput = footprintInput('b', 'Existing footprint B.');
  const existingRecord = await store.writeFootprintSample(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function adminBandishCollisionFixture(store) {
  const oldRecord = await store.writeAdminBandish(adminBandishInput('a', {
    title: 'Original admin item A.',
    dueAt: '2026-09-20',
  }));
  const replacementInput = adminBandishInput('b', {
    title: 'Existing admin item B.',
    dueAt: '2026-10-20',
  });
  const existingRecord = await store.writeAdminBandish(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function bandishCollisionFixture(store) {
  const oldRecord = await store.writeBandish(bandishInput('a', {
    description: 'Original bandish A.',
  }));
  const replacementInput = bandishInput('b', {
    description: 'Existing bandish B.',
    startAt: '2026-07-05T11:00:00.000Z',
    endAt: '2026-07-05T12:00:00.000Z',
  });
  const existingRecord = await store.writeBandish(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function capacityBudgetCollisionFixture(store) {
  const oldRecord = await store.writeCapacityBudget(capacityBudgetInput({
    day: '2026-07-05',
    attentionMode: 'converge',
    minutes: 180,
  }));
  const replacementInput = capacityBudgetInput({
    day: '2026-07-06',
    attentionMode: 'restore',
    minutes: 120,
  });
  const existingRecord = await store.writeCapacityBudget(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function kDecisionCollisionFixture(store) {
  const oldRecord = await store.writeKDecision(kDecisionInput('a', {
    decision: 'Whether to retire decision A.',
  }));
  const replacementInput = kDecisionInput('b', {
    decision: 'Whether to keep existing decision B.',
  });
  const existingRecord = await store.writeKDecision(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

async function vitalCollisionFixture(store) {
  const oldRecord = await store.writeVitalRecord(vitalInput('a', 41));
  const replacementInput = vitalInput('b', 42);
  const existingRecord = await store.writeVitalRecord(replacementInput);
  return { oldRecord, existingRecord, replacementInput };
}

function exposureInput(sourceId, statement) {
  return {
    type: 'observation',
    statement,
    sourceId: `note:${sourceId}`,
    eventAt: '2026-06-25T10:00:00.000Z',
    provenance: { surface: 'ios', lane: 'ambient' },
  };
}

function selfPatternInput(exposureId, suffix) {
  return {
    exposureId,
    action: 'acted',
    pattern: `Prefers contract-safe history ${suffix}.`,
    confidence: 0.7,
    eventAt: '2026-06-25T11:00:00.000Z',
    provenance: { surface: 'loop', lane: 'deliberate' },
  };
}

function footprintInput(sampleId, report) {
  return {
    sampleId,
    eventAt: '2026-06-26T06:30:00.000Z',
    provenance: { surface: 'hrv', lane: 'ambient' },
    phenomenology: {
      rung: 'free',
      instrument: 'free',
      report,
      ratings: { clarity: 3 },
    },
    physiology: { hrv: 52, alpha: 0.2 },
    context: { inMotion: true },
  };
}

function vitalInput(sampleId, hrvMs) {
  return {
    vitalKind: 'hrv',
    sampleId: `vital:${sampleId}`,
    eventAt: '2026-06-26T06:30:00.000Z',
    provenance: { surface: 'healthkit', lane: 'ambient' },
    measurements: { hrvMs },
    units: { hrvMs: 'ms' },
    consent: {
      offPhone: true,
      scope: 'body:vitals',
    },
  };
}

function adminBandishInput(sourceId, overrides = {}) {
  return {
    type: 'RegularQueue',
    effort: 'Hour',
    title: 'Queue admin task',
    sourceId: `admin:${sourceId}`,
    remindAt: '2026-09-01',
    dueAt: '2026-09-20',
    provenance: { surface: 'admin', lane: 'deliberate' },
    ...overrides,
  };
}

function bandishInput(sourceId, overrides = {}) {
  return {
    day: '2026-07-05',
    startAt: '2026-07-05T09:00:00.000Z',
    endAt: '2026-07-05T10:00:00.000Z',
    attentionMode: 'converge',
    ring: 'core',
    description: 'Cadence block',
    sourceId: `bandish:${sourceId}`,
    provenance: { surface: 'cadence', lane: 'deliberate' },
    ...overrides,
  };
}

function capacityBudgetInput(overrides = {}) {
  return {
    day: '2026-07-05',
    attentionMode: 'converge',
    minutes: 180,
    provenance: { surface: 'cadence', lane: 'deliberate' },
    ...overrides,
  };
}

function kDecisionInput(sourceId, overrides = {}) {
  return {
    sourceId: `decision:${sourceId}`,
    eventAt: '2026-06-25T12:00:00.000Z',
    provenance: { surface: 'loop', lane: 'deliberate' },
    decision: 'Whether to count this decision.',
    recommended: 'Count this decision.',
    reason: 'It is captured.',
    confidence: 0.5,
    ...overrides,
  };
}

function genomicInput(genotype) {
  return {
    rsid: 'rs123456',
    chromosome: '1',
    position: '123456',
    genotype,
    trait: 'Index regression trait',
    category: 'test',
    provenance: { surface: 'genome', lane: 'deliberate' },
  };
}

function nonTemporalFields(record) {
  const copy = JSON.parse(JSON.stringify(record));
  delete copy.validFrom;
  delete copy.validTo;
  delete copy.eventAt;
  delete copy.ingestedAt;
  delete copy.supersededById;
  return copy;
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-substrate-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function recordFiles(dataDir) {
  const root = path.join(dataDir, 'substrate');
  const files = [];
  await walk(root, files);
  return files.sort();
}

async function walk(dir, files) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
