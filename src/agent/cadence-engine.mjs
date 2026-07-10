import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import {
  createCadenceActStore,
  normalizeCadenceActionState,
  projectCadenceBlockLifecycle,
} from './cadence-acts.mjs';
import {
  ATTENTION_MODES,
  CADENCE_BANDISH_TYPES,
  CADENCE_RINGS,
} from './cadence.mjs';
import { createOpsGroupStore } from './ops-groups.mjs';
import {
  RECALIBRATION_CHANGE_TYPES,
  recalibrateCadenceDay,
} from './cadence-recalibrate.mjs';

export const CADENCE_DAYS_DIR = path.join('cadence', 'days');
export const CADENCE_NOW_NEXT_DIR = path.join('cadence', 'now-next');
export const CADENCE_DAY_ZERO_CAPTION = "your usual rhythm · k hasn't drafted today";
export const CADENCE_BODY_UPDATE_SIGNALS = Object.freeze(['b1', 'b2', 'b4', 'b6']);
export const CADENCE_RECOMPUTE_TRIGGERS = Object.freeze(['tick', 'body-update', 'act']);

export const DEFAULT_CADENCE_CAPACITY_SEEDS = Object.freeze({
  diverge: 90,
  converge: 180,
  breakthrough: 120,
  operative: 90,
  physical: 60,
  restore: 120,
});

export const DEFAULT_CADENCE_DAY_TEMPLATE = deepFreeze({
  id: 'founder-default-v1',
  kind: 'CadenceDayTemplate',
  schemaVersion: 1,
  title: 'founder default day',
  capacityByMode: DEFAULT_CADENCE_CAPACITY_SEEDS,
  blocks: [
    {
      id: 'restore-0630',
      startTime: '06:30',
      endTime: '07:15',
      ring: 'core',
      attentionMode: 'restore',
      description: 'wake, orient, morning review',
      type: 'routine',
      why: "set the day's shape",
    },
    {
      id: 'physical-0715',
      startTime: '07:15',
      endTime: '08:15',
      ring: 'middle',
      attentionMode: 'physical',
      description: 'body block',
      type: 'workout',
      why: 'build the body budget',
    },
    {
      id: 'deep-0900',
      startTime: '09:00',
      endTime: '11:00',
      ring: 'core',
      attentionMode: 'converge',
      description: 'first deep work block',
      type: 'work',
      why: 'the one thing that compounds',
    },
    {
      id: 'breakthrough-1130',
      startTime: '11:30',
      endTime: '13:00',
      ring: 'core',
      attentionMode: 'breakthrough',
      description: 'hard problem block',
      type: 'work',
      why: 'the one thing that compounds',
    },
    {
      id: 'diverge-1430',
      startTime: '14:30',
      endTime: '15:45',
      ring: 'middle',
      attentionMode: 'diverge',
      description: 'open exploration block',
      type: 'ops',
      why: 'turn the middle of the day into options',
    },
    {
      id: 'ops-1600',
      startTime: '16:00',
      endTime: '17:00',
      ring: 'outer',
      attentionMode: 'operative',
      opsBlock: true,
      description: 'admin and ops queue',
      type: 'ops',
      why: 'contain logistics outside the core',
    },
    {
      id: 'restore-2100',
      startTime: '21:00',
      endTime: '21:45',
      ring: 'core',
      attentionMode: 'restore',
      description: 'evening review and shutdown',
      type: 'routine',
      why: 'reflect and close the loop',
    },
  ],
});

const SCHEMA_VERSION = 1;
const EFFORT_RANK = Object.freeze({ Quick: 0, Hour: 1, Hours: 2 });
const DAY_MS = 24 * 60 * 60 * 1000;
const CADENCE_WHY_MAX_CHARS = 200;
const CADENCE_DETAIL_MAX_BYTES = 2048;

export function createCadenceEngineStore(options = {}) {
  return new CadenceEngineStore(options);
}

export class CadenceEngineStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = normalizeNow(options.now);
    this.opsStore = options.opsStore ?? null;
    this.substrateStore = options.substrateStore ?? null;
    this.actStore = options.actStore ?? null;
  }

  async loadDay(dateInput = this.now()) {
    const date = dateKey(dateInput);
    try {
      const parsed = JSON.parse(await fs.readFile(this.#dayPath(date), 'utf8'));
      return normalizeCadenceDay(parsed);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async currentDay(input = {}) {
    const date = dateKey(input.date ?? this.now());
    return (await this.loadDay(date)) ?? defaultCadenceDay({ date, now: input.now ?? this.now() });
  }

  async saveDay(day) {
    const normalized = normalizeCadenceDay(day);
    await atomicWriteJson(this.#dayPath(normalized.date), normalized);
    return clone(normalized);
  }

  async draftDay(input = {}) {
    const date = dateKey(input.date ?? this.now());
    const adminItems = Array.isArray(input.adminItems)
      ? input.adminItems
      : await this.#loadAdminQueue({ date });
    const day = draftCadenceDay({
      ...input,
      date,
      adminItems,
      now: input.now ?? this.now(),
    });
    await this.saveDay(day);
    return clone(day);
  }

  async recomputeNowNext(input = {}) {
    const now = dateFrom(input.now ?? this.now());
    const triggerInput = input.trigger ??
      (input.type || input.kind ? input : { type: 'tick' });
    const trigger = normalizeCadenceRecomputeTrigger(triggerInput);
    if (!shouldRecomputeCadenceNowNext(trigger)) {
      return deepFreeze({
        ok: true,
        skipped: true,
        reason: 'body_signal_not_allowed',
        trigger,
        allowedBodySignals: [...CADENCE_BODY_UPDATE_SIGNALS],
        generatedAt: iso(now),
      });
    }

    const date = dateKey(input.date ?? now);
    let day = input.day
      ? normalizeCadenceDay(input.day)
      : await this.currentDay({ date, now });
    const acts = Array.isArray(input.acts) ? input.acts : await this.#loadActs({ date });
    const recalibration = recalibrateCadenceDay({ day, now, trigger });
    if (recalibration.changed) {
      day = await this.saveDay(recalibration.day);
    }
    const snapshot = computeCadenceNowNext({ day, now, trigger, acts });
    await this.saveSnapshot(snapshot);
    return clone(snapshot);
  }

  async saveSnapshot(snapshot) {
    const normalized = normalizeNowNextSnapshot(snapshot);
    await atomicWriteJson(this.#snapshotPath(normalized.date), normalized);
    return clone(normalized);
  }

  async loadSnapshot(dateInput = this.now()) {
    const date = dateKey(dateInput);
    try {
      const parsed = JSON.parse(await fs.readFile(this.#snapshotPath(date), 'utf8'));
      return normalizeNowNextSnapshot(parsed);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #loadAdminQueue({ date }) {
    const opsStore = this.opsStore ?? createOpsGroupStore({ dataDir: this.dataDir, now: this.now });
    const substrateStore = this.substrateStore ?? createSubstrateStore({ dataDir: this.dataDir, now: this.now });
    const [triageResult, substrateResult] = await Promise.allSettled([
      opsStore.listAdminItems({ status: 'open' }),
      substrateStore.listRecords('AdminBandish'),
    ]);
    const triageItems = triageResult.status === 'fulfilled' ? triageResult.value : [];
    const substrateItems = substrateResult.status === 'fulfilled'
      ? substrateResult.value.filter((item) => !item.validTo && !item.supersededById)
      : [];
    return normalizeAdminQueue([...triageItems, ...substrateItems], date);
  }

  async #loadActs({ date }) {
    const actStore = this.actStore ?? createCadenceActStore({ dataDir: this.dataDir, now: this.now });
    return actStore.listBlockActs({ date });
  }

  #dayPath(date) {
    return safeDataPath(this.dataDir, path.join(CADENCE_DAYS_DIR, `${date}.json`));
  }

  #snapshotPath(date) {
    return safeDataPath(this.dataDir, path.join(CADENCE_NOW_NEXT_DIR, `${date}.json`));
  }
}

export async function recomputeCadenceNowNext(input = {}) {
  const now = normalizeNow(input.now);
  const store = input.store ?? input.cadenceStore ?? createCadenceEngineStore({
    dataDir: input.dataDir,
    now,
    opsStore: input.opsStore,
    substrateStore: input.substrateStore,
    actStore: input.actStore ?? input.cadenceActStore,
  });
  return store.recomputeNowNext({
    date: input.date,
    day: input.day,
    acts: input.acts,
    now: now(),
    trigger: input.trigger ?? { type: 'tick' },
  });
}

export function defaultCadenceDay(input = {}) {
  const now = dateFrom(input.now ?? new Date());
  const date = dateKey(input.date ?? now);
  return instantiateTemplateDay({
    date,
    now,
    template: input.template ?? DEFAULT_CADENCE_DAY_TEMPLATE,
    source: 'default-template',
    caption: CADENCE_DAY_ZERO_CAPTION,
    drafted: false,
  });
}

export function draftCadenceDay(input = {}) {
  const now = dateFrom(input.now ?? new Date());
  const date = dateKey(input.date ?? now);
  const template = normalizeCadenceTemplate(input.template ?? DEFAULT_CADENCE_DAY_TEMPLATE);
  const adminItems = normalizeAdminQueue(input.adminItems ?? [], date);
  const calendarBlocks = normalizeCalendarEvents(input.calendarEvents ?? [], date);
  const day = instantiateTemplateDay({
    date,
    now,
    template,
    source: 'k-draft',
    drafted: true,
  });
  const blocks = attachAdminQueue(
    [...day.blocks, ...calendarBlocks],
    adminItems,
    { date },
  );

  return deepFreeze({
    ...day,
    id: `cadence_day_${date}`,
    source: 'k-draft',
    drafted: true,
    caption: null,
    blocks,
    draftedAt: iso(now),
    inputs: {
      templateId: template.id,
      calendarEventCount: calendarBlocks.length,
      adminItemCount: adminItems.length,
      sources: ['template', 'calendar', 'admin_queue'],
    },
    adminQueue: adminItems,
  });
}

export function computeCadenceNowNext(input = {}) {
  const day = normalizeCadenceDay(input.day);
  const now = dateFrom(input.now ?? new Date());
  const trigger = normalizeCadenceRecomputeTrigger(input.trigger ?? { type: 'tick' });
  const blocks = projectCadenceBlockLifecycle({
    date: day.date,
    blocks: day.blocks,
    acts: input.acts ?? [],
    now,
  }).blocks.slice().sort(compareBlocks);
  const nowBlock = selectNowBlock(blocks, now);
  const nextBlock = blocks.find((block) =>
    block.id !== nowBlock?.id &&
    block.actionState !== 'completed' &&
    block.skipped !== true &&
    block.id !== nowBlock?.id &&
    dateFrom(block.startAt).getTime() > now.getTime()) ?? null;
  const stream = blocks.map((block) => projectStreamBlock(block, { now, nowBlock, nextBlock }));

  return deepFreeze(stripUndefined({
    ok: true,
    kind: 'CadenceNowNext',
    schemaVersion: SCHEMA_VERSION,
    date: day.date,
    dayId: day.id,
    daySource: day.source,
    dayDrafted: day.drafted === true,
    caption: day.source === 'default-template' ? (day.caption ?? CADENCE_DAY_ZERO_CAPTION) : undefined,
    capacityByMode: day.capacityByMode,
    recalibration: day.recalibration,
    recalibrationChanges: day.recalibrationChanges,
    generatedAt: iso(now),
    trigger,
    nowBlock: nowBlock ? projectStreamBlock(nowBlock, { now, nowBlock, nextBlock }) : null,
    nextBlock: nextBlock ? projectStreamBlock(nextBlock, { now, nowBlock, nextBlock }) : null,
    stream,
  }));
}

export function shouldRecomputeCadenceNowNext(input = {}) {
  const trigger = normalizeCadenceRecomputeTrigger(input);
  if (trigger.type === 'tick' || trigger.type === 'act') return true;
  if (trigger.type === 'body-update') {
    return CADENCE_BODY_UPDATE_SIGNALS.includes(trigger.signal);
  }
  return false;
}

export function normalizeCadenceRecomputeTrigger(input = {}) {
  if (typeof input === 'string') return normalizeCadenceRecomputeTrigger({ type: input });
  if (!isPlainObject(input)) throw new Error('cadence recompute trigger must be an object');
  const rawType = optionalString(input.type ?? input.kind ?? input.trigger);
  const type = normalizeTriggerType(rawType);
  const signal = type === 'body-update'
    ? normalizeBodySignal(input.signal ?? input.signalId ?? input.bodySignal ?? input.body)
    : undefined;
  return deepFreeze(stripUndefined({
    type,
    signal,
    blockId: optionalString(input.blockId),
    action: optionalString(input.action),
    source: optionalString(input.source),
    eventId: optionalString(input.eventId ?? input.id),
  }));
}

function instantiateTemplateDay({ date, now, template, source, caption, drafted }) {
  const normalizedTemplate = normalizeCadenceTemplate(template);
  const blocks = normalizedTemplate.blocks.map((block, index) =>
    instantiateTemplateBlock(block, { date, index }));

  return deepFreeze(stripUndefined({
    id: `${source === 'default-template' ? 'cadence_default' : 'cadence_day'}_${date}`,
    kind: 'CadenceDay',
    schemaVersion: SCHEMA_VERSION,
    date,
    source,
    drafted,
    caption,
    templateId: normalizedTemplate.id,
    capacityByMode: normalizedTemplate.capacityByMode,
    blocks,
    generatedAt: iso(now),
    inputs: source === 'default-template'
      ? {
          templateId: normalizedTemplate.id,
          calendarEventCount: 0,
          adminItemCount: 0,
          sources: ['template'],
        }
      : undefined,
  }));
}

function normalizeCadenceTemplate(input) {
  if (!isPlainObject(input)) throw new Error('cadence template must be an object');
  const id = optionalString(input.id) ?? 'template';
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (blocks.length === 0) throw new Error('cadence template requires blocks');
  return deepFreeze({
    id,
    kind: optionalString(input.kind) ?? 'CadenceDayTemplate',
    schemaVersion: SCHEMA_VERSION,
    title: optionalString(input.title) ?? id,
    capacityByMode: normalizeCapacityByMode(input.capacityByMode ?? DEFAULT_CADENCE_CAPACITY_SEEDS),
    blocks: blocks.map((block) => normalizeTemplateBlock(block)),
  });
}

function normalizeTemplateBlock(input) {
  if (!isPlainObject(input)) throw new Error('template block must be an object');
  return deepFreeze(stripUndefined({
    id: optionalString(input.id ?? input.templateBlockId) ?? blockHash('tmpl', input),
    startTime: normalizeTime(input.startTime, 'startTime'),
    endTime: normalizeTime(input.endTime, 'endTime'),
    ring: normalizeRing(input.ring),
    attentionMode: normalizeAttentionMode(input.attentionMode ?? input.mode),
    description: optionalString(input.description ?? input.title) ?? 'cadence block',
    type: normalizeOptionalCadenceType(input.type),
    why: normalizeOptionalWhy(input.why),
    detail: normalizeOptionalDetail(input.detail),
    opsBlock: input.opsBlock === true ? true : undefined,
    blockType: optionalString(input.blockType),
  }));
}

function instantiateTemplateBlock(block, { date, index }) {
  const times = timeWindowToIso(date, block.startTime, block.endTime);
  return deepFreeze(stripUndefined({
    id: `${block.id}-${date}`,
    templateBlockId: block.id,
    kind: 'CadenceBlock',
    blockType: block.blockType ?? (block.opsBlock ? 'ops' : 'template'),
    date,
    startAt: times.startAt,
    endAt: times.endAt,
    ring: block.ring,
    attentionMode: block.attentionMode,
    description: block.description,
    type: block.type,
    why: block.why,
    detail: block.detail,
    opsBlock: block.opsBlock === true ? true : undefined,
    source: 'template',
    sortOrder: index,
  }));
}

function normalizeCalendarEvents(events, date) {
  if (!Array.isArray(events)) throw new Error('calendarEvents must be an array');
  return events
    .map((event) => normalizeCalendarEvent(event, date))
    .filter(Boolean)
    .sort(compareBlocks)
    .map(deepFreeze);
}

function normalizeCalendarEvent(event, date) {
  if (!isPlainObject(event)) throw new Error('calendar event must be an object');
  const startAt = normalizeIso(event.startAt ?? event.start, 'calendar.startAt');
  const endAt = normalizeIso(event.endAt ?? event.end, 'calendar.endAt');
  if (dateFrom(endAt).getTime() <= dateFrom(startAt).getTime()) {
    throw new Error('calendar event endAt must be after startAt');
  }
  if (!overlapsDate({ startAt, endAt }, date)) return null;

  const sourceId = optionalString(event.id ?? event.eventId ?? event.sourceId) ??
    blockHash('cal', { startAt, endAt, title: event.title ?? event.summary });
  const ring = maybeNormalizeRing(event.ring) ?? 'middle';
  const attentionMode = maybeNormalizeAttentionMode(event.attentionMode ?? event.mode) ?? 'operative';
  return stripUndefined({
    id: `cal-${sourceId}-${date}`.replace(/[^a-zA-Z0-9_.:-]/g, '-'),
    kind: 'CadenceBlock',
    blockType: 'calendar',
    date,
    startAt,
    endAt,
    ring,
    attentionMode,
    description: optionalString(event.description ?? event.title ?? event.summary) ?? 'calendar event',
    source: 'calendar',
    sourceId,
  });
}

function normalizeAdminQueue(items, date) {
  if (!Array.isArray(items)) throw new Error('adminItems must be an array');
  const byId = new Map();
  for (const item of items) {
    const normalized = normalizeAdminQueueItem(item, date);
    if (!normalized) continue;
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort(compareAdminQueueItems).map(deepFreeze);
}

function normalizeAdminQueueItem(item, date) {
  if (!isPlainObject(item)) throw new Error('admin item must be an object');
  const status = optionalString(item.status) ?? 'open';
  if (status !== 'open') return null;
  const id = optionalString(item.id ?? item.itemId ?? item.sourceId) ?? blockHash('adm', item);
  const title = optionalString(item.title ?? item.summary);
  if (!title) return null;
  const type = optionalString(item.type ?? item.adminType) ?? 'RegularQueue';
  const effort = optionalString(item.effort) ?? 'Quick';
  const remindAt = normalizeOptionalIso(item.remindAt ?? item.remindDate ?? item.remind, 'remindAt');
  const dueAt = normalizeOptionalIso(item.dueAt ?? item.dueDate ?? item.due, 'dueAt');
  return stripUndefined({
    id,
    title,
    type,
    effort,
    remindAt,
    dueAt,
    dueToday: dueAt ? dateKey(dueAt) <= date : false,
    remindToday: remindAt ? dateKey(remindAt) <= date : false,
  });
}

function attachAdminQueue(blocks, adminItems, { date }) {
  const sorted = blocks.slice().sort(compareBlocks);
  const queueSummary = adminQueueSummary(adminItems, date);
  const opsIndex = sorted.findIndex((block) =>
    block.opsBlock === true || (block.ring === 'outer' && block.attentionMode === 'operative'));

  if (opsIndex >= 0) {
    sorted[opsIndex] = deepFreeze(stripUndefined({
      ...sorted[opsIndex],
      opsBlock: true,
      blockType: sorted[opsIndex].blockType ?? 'ops',
      adminQueue: queueSummary,
    }));
    return sorted.map(deepFreeze);
  }

  if (adminItems.length === 0) return sorted.map(deepFreeze);
  const times = timeWindowToIso(date, '16:00', '17:00');
  sorted.push(deepFreeze({
    id: `ops-1600-${date}`,
    kind: 'CadenceBlock',
    blockType: 'ops',
    date,
    startAt: times.startAt,
    endAt: times.endAt,
    ring: 'outer',
    attentionMode: 'operative',
    description: 'admin and ops queue',
    opsBlock: true,
    source: 'admin_queue',
    adminQueue: queueSummary,
  }));
  return sorted.sort(compareBlocks).map(deepFreeze);
}

function adminQueueSummary(adminItems, date) {
  return deepFreeze({
    kind: 'cadence.admin_queue',
    date,
    count: adminItems.length,
    dueTodayCount: adminItems.filter((item) => item.dueToday).length,
    timeSensitiveCount: adminItems.filter((item) => item.type === 'TimeSensitive').length,
    itemIds: adminItems.map((item) => item.id),
  });
}

function normalizeCadenceDay(input) {
  if (!isPlainObject(input)) throw new Error('cadence day must be an object');
  const date = dateKey(input.date);
  const blocks = Array.isArray(input.blocks) ? input.blocks.map((block) => normalizeCadenceBlock(block, date)) : [];
  if (blocks.length === 0) throw new Error('cadence day requires blocks');
  return deepFreeze(stripUndefined({
    id: optionalString(input.id) ?? `cadence_day_${date}`,
    kind: optionalString(input.kind) ?? 'CadenceDay',
    schemaVersion: SCHEMA_VERSION,
    date,
    source: normalizeDaySource(input.source),
    drafted: input.drafted === true,
    caption: optionalString(input.caption) ?? null,
    templateId: optionalString(input.templateId),
    capacityByMode: normalizeCapacityByMode(input.capacityByMode ?? DEFAULT_CADENCE_CAPACITY_SEEDS),
    blocks: blocks.sort(compareBlocks),
    generatedAt: normalizeOptionalIso(input.generatedAt, 'generatedAt'),
    draftedAt: normalizeOptionalIso(input.draftedAt, 'draftedAt'),
    inputs: isPlainObject(input.inputs) ? { ...input.inputs } : undefined,
    adminQueue: Array.isArray(input.adminQueue) ? normalizeAdminQueue(input.adminQueue, date) : undefined,
    recalibration: input.recalibration ? normalizeRecalibrationSummary(input.recalibration) : undefined,
    recalibrationChanges: Array.isArray(input.recalibrationChanges)
      ? input.recalibrationChanges.map(normalizeRecalibrationChange)
      : undefined,
  }));
}

function normalizeCadenceBlock(input, date) {
  if (!isPlainObject(input)) throw new Error('cadence block must be an object');
  const startAt = normalizeIso(input.startAt, 'block.startAt');
  const endAt = normalizeIso(input.endAt, 'block.endAt');
  if (dateFrom(endAt).getTime() <= dateFrom(startAt).getTime()) {
    throw new Error('cadence block endAt must be after startAt');
  }
  return deepFreeze(stripUndefined({
    id: optionalString(input.id) ?? blockHash('blk', input),
    kind: optionalString(input.kind) ?? 'CadenceBlock',
    blockType: optionalString(input.blockType),
    date,
    startAt,
    endAt,
    ring: normalizeRing(input.ring),
    attentionMode: normalizeAttentionMode(input.attentionMode ?? input.mode),
    description: optionalString(input.description ?? input.title) ?? 'cadence block',
    type: normalizeOptionalCadenceType(input.type),
    why: normalizeOptionalWhy(input.why),
    detail: normalizeOptionalDetail(input.detail),
    opsBlock: input.opsBlock === true ? true : undefined,
    skipped: input.skipped === true ? true : undefined,
    mergedIntoBlockId: optionalString(input.mergedIntoBlockId),
    source: optionalString(input.source),
    sourceId: optionalString(input.sourceId),
    templateBlockId: optionalString(input.templateBlockId),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : undefined,
    actionState: normalizeOptionalActionState(input.actionState),
    startedAt: normalizeOptionalIso(input.startedAt, 'startedAt'),
    elapsedMinutes: normalizeOptionalElapsedMinutes(input.elapsedMinutes),
    recalibrationChange: input.recalibrationChange
      ? normalizeRecalibrationChange(input.recalibrationChange)
      : undefined,
    adminQueue: isPlainObject(input.adminQueue) ? {
      kind: optionalString(input.adminQueue.kind) ?? 'cadence.admin_queue',
      date,
      count: Number(input.adminQueue.count ?? 0),
      dueTodayCount: Number(input.adminQueue.dueTodayCount ?? 0),
      timeSensitiveCount: Number(input.adminQueue.timeSensitiveCount ?? 0),
      itemIds: Array.isArray(input.adminQueue.itemIds)
        ? input.adminQueue.itemIds.map((item) => optionalString(item)).filter(Boolean)
        : [],
    } : undefined,
  }));
}

function normalizeNowNextSnapshot(input) {
  if (!isPlainObject(input)) throw new Error('cadence now/next snapshot must be an object');
  const date = dateKey(input.date);
  return deepFreeze(stripUndefined({
    ok: input.ok !== false,
    kind: optionalString(input.kind) ?? 'CadenceNowNext',
    schemaVersion: SCHEMA_VERSION,
    date,
    dayId: optionalString(input.dayId),
    daySource: normalizeDaySource(input.daySource),
    dayDrafted: input.dayDrafted === true,
    caption: optionalString(input.caption),
    capacityByMode: normalizeCapacityByMode(input.capacityByMode ?? DEFAULT_CADENCE_CAPACITY_SEEDS),
    recalibration: input.recalibration ? normalizeRecalibrationSummary(input.recalibration) : undefined,
    recalibrationChanges: Array.isArray(input.recalibrationChanges)
      ? input.recalibrationChanges.map(normalizeRecalibrationChange)
      : undefined,
    generatedAt: normalizeIso(input.generatedAt, 'generatedAt'),
    trigger: normalizeCadenceRecomputeTrigger(input.trigger),
    nowBlock: input.nowBlock === null ? null : normalizeStreamBlock(input.nowBlock),
    nextBlock: input.nextBlock === null ? null : normalizeStreamBlock(input.nextBlock),
    stream: Array.isArray(input.stream) ? input.stream.map(normalizeStreamBlock) : [],
  }));
}

function normalizeStreamBlock(input) {
  if (!isPlainObject(input)) throw new Error('stream block must be an object');
  return deepFreeze(stripUndefined({
    id: optionalString(input.id),
    blockType: optionalString(input.blockType),
    type: normalizeOptionalCadenceType(input.type),
    why: normalizeOptionalWhy(input.why),
    startAt: normalizeIso(input.startAt, 'stream.startAt'),
    endAt: normalizeIso(input.endAt, 'stream.endAt'),
    ring: normalizeRing(input.ring),
    attentionMode: normalizeAttentionMode(input.attentionMode),
    description: optionalString(input.description),
    source: optionalString(input.source),
    status: optionalString(input.status),
    actionState: normalizeOptionalActionState(input.actionState),
    startedAt: normalizeOptionalIso(input.startedAt, 'startedAt'),
    elapsedMinutes: normalizeOptionalElapsedMinutes(input.elapsedMinutes),
    skipped: input.skipped === true ? true : undefined,
    mergedIntoBlockId: optionalString(input.mergedIntoBlockId),
    recalibrationChange: input.recalibrationChange
      ? normalizeRecalibrationChange(input.recalibrationChange)
      : undefined,
    isNow: input.isNow === true,
    isNext: input.isNext === true,
    progress: Number.isFinite(Number(input.progress)) ? Number(input.progress) : undefined,
    adminQueue: isPlainObject(input.adminQueue) ? { ...input.adminQueue } : undefined,
  }));
}

function projectStreamBlock(block, { now, nowBlock, nextBlock }) {
  const start = dateFrom(block.startAt).getTime();
  const end = dateFrom(block.endAt).getTime();
  const current = now.getTime();
  const isNow = block.id === nowBlock?.id;
  const isNext = block.id === nextBlock?.id;
  const status = block.actionState === 'completed'
    ? 'completed'
    : block.skipped === true
      ? 'skipped'
      : isNow
        ? 'now'
        : isNext
          ? 'next'
          : current >= end
            ? 'past'
            : current >= start
              ? 'active'
              : 'later';
  return deepFreeze(stripUndefined({
    id: block.id,
    blockType: block.blockType,
    type: block.type,
    why: block.why,
    startAt: block.startAt,
    endAt: block.endAt,
    ring: block.ring,
    attentionMode: block.attentionMode,
    description: block.description,
    source: block.source,
    status,
    actionState: block.actionState,
    startedAt: block.startedAt,
    elapsedMinutes: block.elapsedMinutes,
    skipped: block.skipped === true ? true : undefined,
    mergedIntoBlockId: block.mergedIntoBlockId,
    recalibrationChange: block.recalibrationChange,
    isNow,
    isNext,
    progress: isNow ? progress(start, end, current) : undefined,
    adminQueue: block.adminQueue,
  }));
}

function selectNowBlock(blocks, now) {
  const started = blocks.filter((block) => block.actionState === 'started');
  if (started.length > 0) {
    return started
      .slice()
      .sort((a, b) =>
        dateFrom(b.startedAt ?? b.startAt).getTime() - dateFrom(a.startedAt ?? a.startAt).getTime() ||
        sourcePriority(b.source) - sourcePriority(a.source) ||
        a.id.localeCompare(b.id))
      [0];
  }

  const current = now.getTime();
  const active = blocks.filter((block) => {
    if (block.actionState === 'completed') return false;
    if (block.skipped === true) return false;
    const start = dateFrom(block.startAt).getTime();
    const end = dateFrom(block.endAt).getTime();
    return start <= current && current < end;
  });
  if (active.length === 0) return null;
  return active
    .slice()
    .sort((a, b) =>
      dateFrom(b.startAt).getTime() - dateFrom(a.startAt).getTime() ||
      sourcePriority(b.source) - sourcePriority(a.source) ||
      a.id.localeCompare(b.id))
    [0];
}

function sourcePriority(source) {
  if (source === 'calendar') return 3;
  if (source === 'admin_queue') return 2;
  return 1;
}

function progress(start, end, current) {
  if (end <= start) return 0;
  return Math.max(0, Math.min(1, (current - start) / (end - start)));
}

function normalizeRecalibrationSummary(input) {
  if (!isPlainObject(input)) throw new Error('recalibration must be an object');
  const reason = optionalString(input.reason);
  if (!['wake-init', 'overrun'].includes(reason)) {
    throw new Error(`invalid recalibration reason: ${reason}`);
  }
  return deepFreeze(stripUndefined({
    reason,
    anchorAt: normalizeIso(input.anchorAt, 'recalibration.anchorAt'),
    trigger: input.trigger ? normalizeCadenceRecomputeTrigger(input.trigger) : undefined,
    changes: Array.isArray(input.changes)
      ? input.changes.map(normalizeRecalibrationChange)
      : [],
  }));
}

function normalizeRecalibrationChange(input) {
  if (!isPlainObject(input)) throw new Error('recalibration change must be an object');
  const type = optionalString(input.type);
  if (!RECALIBRATION_CHANGE_TYPES.includes(type)) {
    throw new Error(`invalid recalibration change type: ${type}`);
  }
  const deltaMinutes = Number(input.deltaMinutes);
  if (!Number.isFinite(deltaMinutes)) {
    throw new Error('recalibration deltaMinutes must be finite');
  }
  return deepFreeze(stripUndefined({
    blockId: optionalString(input.blockId),
    type,
    originalStart: normalizeIso(input.originalStart, 'recalibration.originalStart'),
    newStart: normalizeIso(input.newStart, 'recalibration.newStart'),
    deltaMinutes,
  }));
}

function normalizeCapacityByMode(input) {
  if (!isPlainObject(input)) throw new Error('capacityByMode must be an object');
  const output = {};
  for (const mode of ATTENTION_MODES) {
    output[mode] = finiteNonNegative(input[mode] ?? DEFAULT_CADENCE_CAPACITY_SEEDS[mode], `capacityByMode.${mode}`);
  }
  return deepFreeze(output);
}

function normalizeDaySource(value) {
  const source = optionalString(value) ?? 'k-draft';
  if (!['default-template', 'k-draft'].includes(source)) throw new Error(`invalid cadence day source: ${source}`);
  return source;
}

function normalizeTriggerType(value) {
  const type = optionalString(value)?.toLowerCase().replace(/_/g, '-');
  if (!type || !CADENCE_RECOMPUTE_TRIGGERS.includes(type)) {
    throw new Error(`invalid cadence recompute trigger: ${value}`);
  }
  return type;
}

function normalizeBodySignal(value) {
  const signal = optionalString(value)?.toLowerCase();
  return signal;
}

function normalizeRing(value) {
  const ring = optionalString(value)?.toLowerCase();
  if (!ring || !CADENCE_RINGS.includes(ring)) throw new Error(`invalid cadence ring: ${value}`);
  return ring;
}

function maybeNormalizeRing(value) {
  try {
    return normalizeRing(value);
  } catch {
    return undefined;
  }
}

function normalizeAttentionMode(value) {
  const mode = optionalString(value)?.toLowerCase();
  if (!mode || !ATTENTION_MODES.includes(mode)) throw new Error(`invalid attention mode: ${value}`);
  return mode;
}

function normalizeOptionalCadenceType(value) {
  const type = optionalString(value);
  if (!type) return undefined;
  if (!CADENCE_BANDISH_TYPES.includes(type)) throw new Error(`invalid cadence block type: ${type}`);
  return type;
}

function normalizeOptionalWhy(value) {
  const why = optionalString(value);
  if (!why) return undefined;
  if (why.length > CADENCE_WHY_MAX_CHARS) {
    throw new Error(`why must be ${CADENCE_WHY_MAX_CHARS} characters or fewer`);
  }
  return why;
}

function normalizeOptionalDetail(value) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error('detail must be a plain object');
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('detail must be JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > CADENCE_DETAIL_MAX_BYTES) {
    throw new Error(`detail must be ${CADENCE_DETAIL_MAX_BYTES} bytes or fewer`);
  }
  return JSON.parse(json);
}

function maybeNormalizeAttentionMode(value) {
  try {
    return normalizeAttentionMode(value);
  } catch {
    return undefined;
  }
}

function normalizeTime(value, label) {
  const text = optionalString(value);
  if (!text || !/^\d{2}:\d{2}$/.test(text)) throw new Error(`${label} must be HH:mm`);
  const [hour, minute] = text.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error(`${label} must be HH:mm`);
  return text;
}

function timeWindowToIso(date, startTime, endTime) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime());
  start.setUTCMinutes(startMinutes);
  end.setUTCMinutes(endMinutes);
  if (end.getTime() <= start.getTime()) end.setTime(end.getTime() + DAY_MS);
  return {
    startAt: iso(start),
    endAt: iso(end),
  };
}

function timeToMinutes(value) {
  const time = normalizeTime(value, 'time');
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function overlapsDate({ startAt, endAt }, date) {
  const dayStart = new Date(`${date}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + DAY_MS;
  return dateFrom(startAt).getTime() < dayEnd && dateFrom(endAt).getTime() > dayStart;
}

function compareBlocks(a, b) {
  return (
    dateFrom(a.startAt).getTime() - dateFrom(b.startAt).getTime() ||
    dateFrom(a.endAt).getTime() - dateFrom(b.endAt).getTime() ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

function compareAdminQueueItems(a, b) {
  return (
    sortableIso(a.remindAt).localeCompare(sortableIso(b.remindAt)) ||
    sortableIso(a.dueAt).localeCompare(sortableIso(b.dueAt)) ||
    (EFFORT_RANK[a.effort] ?? 99) - (EFFORT_RANK[b.effort] ?? 99) ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

function sortableIso(value) {
  return optionalString(value) ?? '9999-12-31T23:59:59.999Z';
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function normalizeOptionalIso(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeIso(value, label);
}

function normalizeOptionalActionState(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeCadenceActionState(value);
}

function normalizeOptionalElapsedMinutes(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('elapsedMinutes must be a non-negative number');
  return Math.floor(number);
}

function normalizeIso(value, label) {
  return iso(dateFrom(value, label));
}

function dateKey(value) {
  const text = optionalString(value);
  if (text && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
      throw new Error(`invalid date: ${value}`);
    }
    return text;
  }
  return dateFrom(value, 'date').toISOString().slice(0, 10);
}

function dateFrom(value, label = 'date') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function normalizeNow(now) {
  if (typeof now === 'function') return now;
  if (now === undefined) return () => new Date();
  const fixed = dateFrom(now);
  return () => fixed;
}

function blockHash(prefix, value) {
  return `${prefix}_${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)}`;
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

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
