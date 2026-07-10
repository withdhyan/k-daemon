import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';
import { atomicWriteJson } from './routines.mjs';

export const MOTION_PROGRESS_TAGS = Object.freeze(['motion', 'progress']);
export const CADENCE_ACTS_DIR = path.join('cadence', 'acts');
export const WORK_ENTRIES_DIR = path.join('work', 'entries');

const SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z][a-z0-9_:-]{2,127}$/;
const TEXT_MAX_CHARS = 240;
const NOTE_MAX_CHARS = 1000;

export function createMotionProgressStore(options = {}) {
  return new CadenceActStore(options);
}

export class CadenceActStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = normalizeNow(options.now);
  }

  async recordAct(input = {}) {
    const act = normalizeCadenceAct(input, { now: this.now() });
    await atomicWriteJson(this.#actPath(act.id), act);
    return clone(act);
  }

  async loadAct(actId) {
    return this.#loadRecord(this.#actPath(normalizeId(actId, 'actId')), normalizeLoadedCadenceAct);
  }

  async listActs(input = {}) {
    return (await listJsonRecords(this.dataDir, CADENCE_ACTS_DIR))
      .map(normalizeLoadedCadenceAct)
      .filter((act) => recordMatches(act, input))
      .sort(compareRecords)
      .map(clone);
  }

  async tagAct(input = {}) {
    const actId = normalizeId(input.actId ?? input.id, 'actId');
    const existing = await this.loadAct(actId);
    if (!existing) throw new Error(`cadence act not found: ${actId}`);

    const updated = withMotionProgressTag(existing, input, this.now());
    await atomicWriteJson(this.#actPath(updated.id), updated);
    return clone(updated);
  }

  async recordWorkEntry(input = {}) {
    const entry = normalizeWorkEntry(input, { now: this.now() });
    await atomicWriteJson(this.#workEntryPath(entry.id), entry);
    return clone(entry);
  }

  async loadWorkEntry(entryId) {
    return this.#loadRecord(this.#workEntryPath(normalizeId(entryId, 'entryId')), normalizeLoadedWorkEntry);
  }

  async listWorkEntries(input = {}) {
    return (await listJsonRecords(this.dataDir, WORK_ENTRIES_DIR))
      .map(normalizeLoadedWorkEntry)
      .filter((entry) => recordMatches(entry, input))
      .sort(compareRecords)
      .map(clone);
  }

  async tagWorkEntry(input = {}) {
    const entryId = normalizeId(input.entryId ?? input.workEntryId ?? input.id, 'entryId');
    const existing = await this.loadWorkEntry(entryId);
    if (!existing) throw new Error(`work entry not found: ${entryId}`);

    const updated = withMotionProgressTag(existing, input, this.now());
    await atomicWriteJson(this.#workEntryPath(updated.id), updated);
    return clone(updated);
  }

  async #loadRecord(file, normalize) {
    try {
      return clone(normalize(JSON.parse(await fs.readFile(file, 'utf8'))));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #actPath(actId) {
    return safeDataPath(this.dataDir, path.join(CADENCE_ACTS_DIR, `${actId}.json`));
  }

  #workEntryPath(entryId) {
    return safeDataPath(this.dataDir, path.join(WORK_ENTRIES_DIR, `${entryId}.json`));
  }
}

export function normalizeMotionProgressTag(value, label = 'motionProgressTag') {
  const tag = requiredString(value, label).toLowerCase();
  if (!MOTION_PROGRESS_TAGS.includes(tag)) throw new Error(`invalid ${label}: ${tag}`);
  return tag;
}

export function optionalMotionProgressTag(input) {
  const value = input?.motionProgressTag ??
    input?.motionVsProgressTag ??
    input?.motionVsProgress ??
    input?.motionProgress ??
    input?.progressTag ??
    input?.tag;
  return value === undefined || value === null || value === ''
    ? undefined
    : normalizeMotionProgressTag(value);
}

export function projectMotionProgressEntry(record) {
  const kind = requiredString(record?.kind, 'record.kind');
  const sourceType = kind === 'CadenceAct'
    ? 'cadence-act'
    : kind === 'WorkEntry'
      ? 'work-entry'
      : undefined;
  if (!sourceType) throw new Error(`unsupported motion/progress source: ${kind}`);

  return stripUndefined({
    id: requiredString(record.id, 'record.id'),
    kind,
    sourceType,
    title: optionalString(record.title),
    action: optionalString(record.action),
    outcome: optionalString(record.outcome),
    blockId: optionalString(record.blockId),
    date: requiredString(record.date, 'record.date'),
    eventAt: normalizeIso(record.eventAt, 'eventAt'),
    motionProgressTag: optionalMotionProgressTag(record),
  });
}

function normalizeCadenceAct(input, { now }) {
  const eventAt = normalizeIso(input.eventAt ?? input.completedAt ?? now, 'eventAt');
  const timestamp = normalizeIso(input.updatedAt ?? input.createdAt ?? now, 'updatedAt');
  const blockId = boundedText(input.blockId ?? input.block, 'blockId', TEXT_MAX_CHARS);
  const action = boundedText(input.action ?? input.act, 'action', TEXT_MAX_CHARS);
  const motionProgressTag = optionalMotionProgressTag(input);
  const id = normalizeOptionalId(input.id ?? input.actId) ??
    recordId('cact', ['CadenceAct', blockId, action, eventAt, optionalString(input.outcome)]);

  return Object.freeze(stripUndefined({
    id,
    kind: 'CadenceAct',
    schemaVersion: SCHEMA_VERSION,
    blockId,
    action,
    title: boundedOptionalText(input.title, TEXT_MAX_CHARS),
    outcome: boundedOptionalText(input.outcome, TEXT_MAX_CHARS),
    motionProgressTag,
    date: dayKey(input.date ?? eventAt),
    eventAt,
    note: boundedOptionalText(input.note, NOTE_MAX_CHARS),
    source: optionalString(input.source) ?? 'cadence',
    createdAt: normalizeIso(input.createdAt ?? timestamp, 'createdAt'),
    updatedAt: timestamp,
    taggedAt: motionProgressTag ? normalizeIso(input.taggedAt ?? timestamp, 'taggedAt') : undefined,
  }));
}

function normalizeLoadedCadenceAct(value) {
  return normalizeCadenceAct(value, {
    now: value?.updatedAt ?? value?.createdAt ?? value?.eventAt ?? new Date(),
  });
}

function normalizeWorkEntry(input, { now }) {
  const eventAt = normalizeIso(input.eventAt ?? input.completedAt ?? now, 'eventAt');
  const timestamp = normalizeIso(input.updatedAt ?? input.createdAt ?? now, 'updatedAt');
  const title = boundedText(input.title ?? input.summary, 'title', TEXT_MAX_CHARS);
  const motionProgressTag = optionalMotionProgressTag(input);
  const id = normalizeOptionalId(input.id ?? input.entryId ?? input.workEntryId) ??
    recordId('work', [
      'WorkEntry',
      title,
      eventAt,
      optionalString(input.sourceId),
      optionalString(input.planId),
      optionalString(input.unitId),
      optionalString(input.outcome),
    ]);

  return Object.freeze(stripUndefined({
    id,
    kind: 'WorkEntry',
    schemaVersion: SCHEMA_VERSION,
    title,
    outcome: boundedOptionalText(input.outcome, TEXT_MAX_CHARS),
    motionProgressTag,
    date: dayKey(input.date ?? eventAt),
    eventAt,
    source: optionalString(input.source) ?? 'work',
    sourceId: optionalString(input.sourceId ?? input.sourceEntryId),
    planId: optionalString(input.planId),
    unitId: optionalString(input.unitId),
    note: boundedOptionalText(input.note, NOTE_MAX_CHARS),
    createdAt: normalizeIso(input.createdAt ?? timestamp, 'createdAt'),
    updatedAt: timestamp,
    taggedAt: motionProgressTag ? normalizeIso(input.taggedAt ?? timestamp, 'taggedAt') : undefined,
  }));
}

function normalizeLoadedWorkEntry(value) {
  return normalizeWorkEntry(value, {
    now: value?.updatedAt ?? value?.createdAt ?? value?.eventAt ?? new Date(),
  });
}

function withMotionProgressTag(record, input, now) {
  const motionProgressTag = normalizeMotionProgressTag(
    input.motionProgressTag ??
      input.motionVsProgressTag ??
      input.motionVsProgress ??
      input.motionProgress ??
      input.progressTag ??
      input.tag,
  );
  const updatedAt = normalizeIso(input.updatedAt ?? now, 'updatedAt');
  return Object.freeze(stripUndefined({
    ...record,
    motionProgressTag,
    updatedAt,
    taggedAt: normalizeIso(input.taggedAt ?? updatedAt, 'taggedAt'),
  }));
}

async function listJsonRecords(dataDir, relativeDir) {
  const dir = safeDataPath(dataDir, relativeDir);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

function recordMatches(record, input = {}) {
  const tag = optionalMotionProgressTag(input);
  if (tag && record.motionProgressTag !== tag) return false;

  const date = optionalString(input.date);
  if (date && record.date !== dayKey(date)) return false;

  const startAt = input.startAt ? Date.parse(normalizeIso(input.startAt, 'startAt')) : null;
  const endAt = input.endAt ? Date.parse(normalizeIso(input.endAt, 'endAt')) : null;
  const eventAt = Date.parse(record.eventAt);
  if (startAt !== null && eventAt < startAt) return false;
  if (endAt !== null && eventAt >= endAt) return false;

  return true;
}

function normalizeOptionalId(value) {
  const id = optionalString(value);
  return id ? normalizeId(id, 'id') : undefined;
}

function normalizeId(value, label) {
  const id = requiredString(value, label);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} has invalid id shape`);
  return id;
}

function recordId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}

function boundedText(value, label, maxChars) {
  const text = requiredString(value, label);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function boundedOptionalText(value, maxChars) {
  const text = optionalString(value);
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function dayKey(value) {
  return normalizeIso(value, 'date').slice(0, 10);
}

function normalizeIso(value, label) {
  try {
    return iso(value);
  } catch {
    throw new Error(`${label} must be a valid date`);
  }
}

function compareRecords(a, b) {
  return a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNow(value) {
  if (typeof value === 'function') return value;
  if (value !== undefined && value !== null) return () => value;
  return () => new Date();
}
