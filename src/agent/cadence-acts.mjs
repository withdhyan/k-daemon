import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';
import {
  ATTENTION_CATEGORY_CADENCE_NUDGE,
  admit as admitAttentionBudget,
} from './attention-budget.mjs';

export const CADENCE_DIR = 'cadence';
export const CADENCE_ACTS_DIR = path.join(CADENCE_DIR, 'acts');
export const CADENCE_BACKFILL_DIR = path.join(CADENCE_DIR, 'backfill');
export const CADENCE_NUDGE_DISPOSITIONS_DIR = path.join(CADENCE_DIR, 'nudge-dispositions');
export const CADENCE_SUPPRESSED_TODAY_DIR = path.join(CADENCE_DIR, 'suppressed-today');

export const CADENCE_BLOCK_ACTS = Object.freeze([
  'start',
  'pause',
  'complete',
  'skip',
  'extend_15',
  'tws_yes',
  'tws_no',
  'no_response',
]);

export const CADENCE_BLOCK_ACTION_STATES = Object.freeze(['available', 'started', 'completed']);
export const CADENCE_NUDGE_DISPOSITIONS = Object.freeze(['act', 'watch', 'suppress']);

const SCHEMA_VERSION = 1;
const NOTE_MAX_CHARS = 1000;
const TITLE_MAX_CHARS = 240;
const LIFECYCLE_ACTIONS = new Set(['start', 'pause', 'complete', 'skip']);
const NUDGE_ACTION_MAX_BYTES = 4096;
const TWS_ACTIONS = new Set(['tws_yes', 'tws_no', 'no_response']);
const TWS_ANSWER_ACTIONS = new Set(['tws_yes', 'tws_no']);
const BACKFILL_STATUSES = Object.freeze(['pending', 'answered', 'no_response']);

export function createCadenceActStore(options = {}) {
  return new CadenceActStore(options);
}

export class CadenceActStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = normalizeNow(options.now);
    this.env = options.env;
    this.logger = options.logger;
    this.attentionBudgetCaps = options.attentionBudgetCaps;
  }

  async recordBlockAct(input = {}) {
    let record = normalizeBlockAct(input, this.now());

    if (TWS_ACTIONS.has(record.action)) {
      const existingTws = await this.#firstTwsOutcome(record.date, record.blockId);
      if (existingTws) {
        return deepFreeze({
          record: clone(existingTws),
          created: false,
          conflict: existingTws.action !== record.action,
        });
      }
    }

    const existing = await this.#loadRecord(this.#actPath(record.id));
    if (existing) {
      return deepFreeze({
        record: clone(existing),
        created: false,
        conflict: existing.action !== record.action,
      });
    }

    record = await this.#withLifecycleAfterAct(record);
    await writeJson(this.#actPath(record.id), record);
    if (TWS_ANSWER_ACTIONS.has(record.action)) {
      await this.#markBackfill(record.date, record.blockId, 'answered', record.eventAt);
    } else if (record.action === 'no_response') {
      await this.#markBackfill(record.date, record.blockId, 'no_response', record.eventAt);
    }

    return deepFreeze({ record: clone(record), created: true, conflict: false });
  }

  async listBlockActs(input = {}) {
    const date = input.date ? dayKey(input.date) : undefined;
    const blockId = input.blockId ? requiredString(input.blockId, 'blockId') : undefined;
    return (await listJsonRecords(this.#dir(CADENCE_ACTS_DIR)))
      .map(normalizeLoadedBlockAct)
      .filter((record) => (!date || record.date === date) && (!blockId || record.blockId === blockId))
      .sort(compareBlockActs)
      .map(clone);
  }

  async summarizeBlockTws(input = {}) {
    const date = dayKey(input.date ?? this.now());
    const blockIds = normalizeBlockIds(input);
    const acts = await this.listBlockActs({ date });
    return summarizeBlockTws({ date, blockIds, acts });
  }

  async queueEveningBackfill(input = {}) {
    const date = dayKey(input.date ?? this.now());
    const blockIds = normalizeBlockIds(input);
    const queued = [];
    let skippedAnswered = 0;

    for (const blockId of blockIds) {
      const existingTws = await this.#firstTwsOutcome(date, blockId);
      if (existingTws) {
        skippedAnswered += 1;
        if (TWS_ANSWER_ACTIONS.has(existingTws.action)) {
          await this.#markBackfill(date, blockId, 'answered', existingTws.eventAt);
        } else if (existingTws.action === 'no_response') {
          await this.#markBackfill(date, blockId, 'no_response', existingTws.eventAt);
        }
        continue;
      }

      const item = await this.#ensureBackfillItem({
        date,
        blockId,
        dueAt: input.dueAt,
        createdAt: input.createdAt,
      });
      queued.push(item);
    }

    return deepFreeze({ date, queued, skippedAnswered });
  }

  async recordNoResponseOutcomes(input = {}) {
    const date = dayKey(input.date ?? this.now());
    const explicitBlockIds = normalizeBlockIds(input, { allowEmpty: true });
    const queue = await this.listEveningBackfillQueue({ date });
    const blockIds = explicitBlockIds.length > 0
      ? explicitBlockIds
      : queue.map((item) => item.blockId);
    const records = [];
    const skippedAnswered = [];

    for (const blockId of blockIds) {
      const existingTws = await this.#firstTwsOutcome(date, blockId);
      if (existingTws) {
        if (TWS_ANSWER_ACTIONS.has(existingTws.action)) {
          skippedAnswered.push(blockId);
          await this.#markBackfill(date, blockId, 'answered', existingTws.eventAt);
        } else if (existingTws.action === 'no_response') {
          await this.#markBackfill(date, blockId, 'no_response', existingTws.eventAt);
        }
        continue;
      }

      const result = await this.recordBlockAct({
        blockId,
        date,
        action: 'no_response',
        eventAt: input.eventAt,
        source: input.source ?? 'evening_backfill',
      });
      records.push(result.record);
    }

    return deepFreeze({ date, records, skippedAnswered });
  }

  async listEveningBackfillQueue(input = {}) {
    const date = input.date ? dayKey(input.date) : undefined;
    const status = input.status ? normalizeBackfillStatus(input.status) : undefined;
    return (await listJsonRecords(this.#dir(CADENCE_BACKFILL_DIR)))
      .map(normalizeLoadedBackfillItem)
      .filter((item) => (!date || item.date === date) && (!status || item.status === status))
      .sort(compareBackfillItems)
      .map(clone);
  }

  async recordNudgeDisposition(input = {}) {
    const record = normalizeNudgeDisposition(input, this.now());
    const existing = await this.#loadRecord(this.#nudgeDispositionPath(record.id));
    if (existing) {
      return deepFreeze({
        record: clone(existing),
        suppressedToday: record.disposition === 'suppress'
          ? await this.#recordSuppressedToday(suppressedFromDisposition(existing))
          : null,
        created: false,
      });
    }

    await writeJson(this.#nudgeDispositionPath(record.id), record);
    const suppressedToday = record.disposition === 'suppress'
      ? await this.#recordSuppressedToday(suppressedFromDisposition(record))
      : null;

    return deepFreeze({
      record: clone(record),
      suppressedToday,
      created: true,
    });
  }

  async listNudgeDispositions(input = {}) {
    const date = input.date ? dayKey(input.date) : undefined;
    const blockId = input.blockId ? requiredString(input.blockId, 'blockId') : undefined;
    const nudgeId = input.nudgeId ? requiredString(input.nudgeId, 'nudgeId') : undefined;
    return (await listJsonRecords(this.#dir(CADENCE_NUDGE_DISPOSITIONS_DIR)))
      .map(normalizeLoadedNudgeDisposition)
      .filter((record) =>
        (!date || record.date === date) &&
        (!blockId || record.blockId === blockId) &&
        (!nudgeId || record.nudgeId === nudgeId))
      .sort(compareNudgeDispositions)
      .map(clone);
  }

  async listSuppressedToday(input = {}) {
    const date = input.date ? dayKey(input.date) : undefined;
    const blockId = input.blockId ? requiredString(input.blockId, 'blockId') : undefined;
    return (await listJsonRecords(this.#dir(CADENCE_SUPPRESSED_TODAY_DIR)))
      .map(normalizeLoadedSuppressedToday)
      .filter((record) => (!date || record.date === date) && (!blockId || record.blockId === blockId))
      .sort(compareSuppressedToday)
      .map(clone);
  }

  async projectNudgesOntoBlocks(input = {}) {
    const date = dayKey(input.date ?? this.now());
    const existingSuppressed = await this.listSuppressedToday({ date });
    const projected = projectNudgesOntoBlocks({
      ...input,
      date,
      suppressedToday: [
        ...existingSuppressed,
        ...(Array.isArray(input.suppressedToday) ? input.suppressedToday : []),
      ],
    });

    for (const record of projected.suppressedToRecord) {
      await this.#recordSuppressedToday(record);
    }

    if (input.attentionBudget === false) return projected;
    return applyAttentionBudgetToNudgeProjection(projected, {
      dataDir: this.dataDir,
      now: this.now(),
      env: input.env ?? this.env,
      logger: input.logger ?? this.logger,
      caps: input.attentionBudgetCaps ?? this.attentionBudgetCaps,
    });
  }

  async #firstTwsOutcome(date, blockId) {
    const matches = (await this.listBlockActs({ date, blockId }))
      .filter((record) => TWS_ACTIONS.has(record.action))
      .sort(compareBlockActs);
    return matches[0] ?? null;
  }

  async #withLifecycleAfterAct(record) {
    const acts = (await this.listBlockActs({ date: record.date, blockId: record.blockId }))
      .filter((act) => act.id !== record.id);
    const state = cadenceBlockLifecycleById({
      acts: [...acts, record],
      date: record.date,
      now: record.eventAt,
    }).get(record.blockId) ?? defaultLifecycleState();
    return deepFreeze(stripUndefined({
      ...record,
      ...projectLifecycleFields(state),
    }));
  }

  async #ensureBackfillItem(input) {
    const now = iso(this.now());
    const item = normalizeBackfillItem({
      ...input,
      status: 'pending',
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    });
    const existing = await this.#loadRecord(this.#backfillPath(item.id));
    if (existing) return clone(normalizeLoadedBackfillItem(existing));
    await writeJson(this.#backfillPath(item.id), item);
    return clone(item);
  }

  async #markBackfill(date, blockId, status, eventAt) {
    const id = backfillId(date, blockId);
    const file = this.#backfillPath(id);
    const existing = await this.#loadRecord(file);
    if (!existing) return null;
    const normalized = normalizeLoadedBackfillItem(existing);
    if (normalized.status === status) return clone(normalized);
    const updated = normalizeBackfillItem({
      ...normalized,
      status,
      resolvedAt: eventAt ?? this.now(),
      updatedAt: this.now(),
    });
    await writeJson(file, updated);
    return clone(updated);
  }

  async #recordSuppressedToday(input) {
    const record = normalizeSuppressedToday(input, this.now());
    const existing = await this.#loadRecord(this.#suppressedTodayPath(record.id));
    if (existing) return clone(normalizeLoadedSuppressedToday(existing));
    await writeJson(this.#suppressedTodayPath(record.id), record);
    return clone(record);
  }

  async #loadRecord(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #actPath(recordId) {
    return path.join(this.#dir(CADENCE_ACTS_DIR), `${recordId}.json`);
  }

  #backfillPath(recordId) {
    return path.join(this.#dir(CADENCE_BACKFILL_DIR), `${recordId}.json`);
  }

  #nudgeDispositionPath(recordId) {
    return path.join(this.#dir(CADENCE_NUDGE_DISPOSITIONS_DIR), `${recordId}.json`);
  }

  #suppressedTodayPath(recordId) {
    return path.join(this.#dir(CADENCE_SUPPRESSED_TODAY_DIR), `${recordId}.json`);
  }

  #dir(relativePath) {
    return path.join(this.dataDir, relativePath);
  }
}

export function summarizeBlockTws(input = {}) {
  const date = dayKey(input.date ?? new Date());
  const blockIds = uniqueStrings(input.blockIds ?? []);
  const byBlock = new Map();
  for (const act of Array.isArray(input.acts) ? input.acts : []) {
    if (act.date !== date || !TWS_ACTIONS.has(act.action)) continue;
    if (!byBlock.has(act.blockId)) byBlock.set(act.blockId, act);
  }

  let wellSpent = 0;
  let notWellSpent = 0;
  let noResponse = 0;
  for (const blockId of blockIds) {
    const act = byBlock.get(blockId);
    if (!act) continue;
    if (act.action === 'tws_yes') wellSpent += 1;
    if (act.action === 'tws_no') notWellSpent += 1;
    if (act.action === 'no_response') noResponse += 1;
  }

  const totalBlocks = blockIds.length;
  const answered = wellSpent + notWellSpent;
  return deepFreeze({
    date,
    totalBlocks,
    answered,
    wellSpent,
    notWellSpent,
    noResponse,
    pending: Math.max(0, totalBlocks - answered - noResponse),
    responseRate: totalBlocks === 0 ? null : answered / totalBlocks,
    wellSpentRate: answered === 0 ? null : wellSpent / answered,
  });
}

export function projectNudgesOntoBlocks(input = {}) {
  const date = dayKey(input.date ?? new Date());
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const candidates = (Array.isArray(input.nudges) ? input.nudges : [])
    .map((nudge) => normalizeNudgeCandidate(nudge, date))
    .filter(Boolean);
  const suppressedSet = new Set(
    (Array.isArray(input.suppressedToday) ? input.suppressedToday : [])
      .filter((record) => !record?.date || dayKey(record.date) === date)
      .map((record) => suppressedKey(date, record?.nudgeId ?? record?.id, record?.blockId)),
  );
  const rankedByBlock = {};
  const suppressedToRecord = [];

  const projectedBlocks = blocks.map((block) => {
    const blockId = requiredString(block.id ?? block.blockId, 'block.id');
    const blockCandidates = candidates.filter((candidate) => candidate.blockId === blockId);
    const suppressed = [];
    const eligible = [];

    for (const candidate of blockCandidates) {
      const alreadySuppressed = suppressedSet.has(suppressedKey(date, candidate.id, blockId));
      if (alreadySuppressed || candidate.disposition === 'suppress') {
        suppressed.push({ ...candidate, placement: 'suppressed' });
        if (!alreadySuppressed && candidate.disposition === 'suppress') {
          suppressedToRecord.push({
            date,
            blockId,
            nudgeId: candidate.id,
            title: candidate.title,
            reason: 'disposition_suppress',
            source: 'cadence_projection',
          });
        }
        continue;
      }
      eligible.push(candidate);
    }

    eligible.sort(compareNudgeCandidates);
    suppressed.sort(compareNudgeCandidates);

    const ranked = [
      ...eligible.map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        placement: index === 0 ? 'slot' : 'ranked_out',
      })),
      ...suppressed,
    ].map(projectRankedNudge);
    rankedByBlock[blockId] = ranked;

    const slot = ranked.find((candidate) => candidate.placement === 'slot');
    if (!slot) return block;
    return {
      ...block,
      nudgeSlot: {
        ...slot,
        totalCandidates: blockCandidates.length,
      },
    };
  });

  return deepFreeze({
    date,
    blocks: projectedBlocks,
    rankedByBlock,
    suppressedToRecord: suppressedToRecord.map(normalizeSuppressedTodayInput),
  });
}

function applyAttentionBudgetToNudgeProjection(projected, options = {}) {
  const slots = [];
  for (const block of projected.blocks) {
    if (!isPlainObject(block?.nudgeSlot)) continue;
    slots.push({
      ...block.nudgeSlot,
      blockId: block.nudgeSlot.blockId ?? block.id,
    });
  }

  if (slots.length === 0) {
    return projected;
  }

  const admitted = [];
  const queued = [];
  for (const slot of slots.sort(compareNudgeCandidates)) {
    const budget = admitAttentionBudget(nudgeBudgetRecord(slot, projected.date), options);
    if (budget.queued) queued.push({ slot, budget });
    else admitted.push({ slot, budget });
  }

  if (queued.length === 0 && admitted.every((entry) => !entry.budget.failSoft)) {
    return projected;
  }

  const queuedByBlock = new Map(queued.map((entry) => [entry.slot.blockId, entry]));
  const budgetByNudge = new Map([...admitted, ...queued].map((entry) => [entry.slot.id, entry.budget]));
  const blocks = projected.blocks.map((block) => {
    if (!queuedByBlock.has(block.id)) return block;
    const next = { ...block };
    delete next.nudgeSlot;
    return next;
  });
  const rankedByBlock = {};

  for (const [blockId, entries] of Object.entries(projected.rankedByBlock ?? {})) {
    rankedByBlock[blockId] = entries.map((entry) => {
      const budget = budgetByNudge.get(entry.id);
      if (!budget) return entry;
      return stripUndefined({
        ...entry,
        placement: budget.queued ? 'queued' : entry.placement,
        queuedUntil: budget.queuedUntil,
        attentionBudget: budgetSummary(budget),
      });
    });
  }

  return deepFreeze({
    ...projected,
    blocks,
    rankedByBlock,
    attentionBudget: {
      category: ATTENTION_CATEGORY_CADENCE_NUDGE,
      admitted: admitted.map((entry) => budgetSummary(entry.budget)),
      queued: queued.map((entry) => budgetSummary(entry.budget)),
    },
  });
}

function nudgeBudgetRecord(slot, date) {
  return stripUndefined({
    category: ATTENTION_CATEGORY_CADENCE_NUDGE,
    id: slot.id,
    nudgeId: slot.id,
    blockId: slot.blockId,
    title: slot.title,
    text: slot.body,
    source: slot.source ?? 'cadence_projection',
    score: slot.score,
    rankScore: slot.score,
    eventAt: slot.createdAt ?? `${date}T00:00:00.000Z`,
    createdAt: slot.createdAt ?? `${date}T00:00:00.000Z`,
    cardId: slot.cardId,
  });
}

function budgetSummary(result) {
  return stripUndefined({
    status: result.status,
    category: result.category,
    cap: result.cap,
    spent: result.spent,
    queuedUntil: result.queuedUntil,
    failSoft: result.failSoft,
    path: result.path,
  });
}

export function projectCadenceBlockLifecycle(input = {}) {
  const date = input.date ? dayKey(input.date) : undefined;
  const now = input.now === undefined || input.now === null
    ? undefined
    : dateFrom(typeof input.now === 'function' ? input.now() : input.now, 'now');
  const acts = normalizeLifecycleActs(input.acts ?? [], date);
  const lifecycleByBlock = cadenceBlockLifecycleById({ acts, date, now });
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];

  const projectedBlocks = blocks.map((block) => {
    const blockId = requiredString(block?.id ?? block?.blockId, 'block.id');
    const lifecycle = lifecycleByBlock.get(blockId) ?? lifecycleFromBlock(block, { now });
    return deepFreeze(stripUndefined({
      ...block,
      ...projectLifecycleFields(lifecycle),
    }));
  });

  return deepFreeze({
    date,
    blocks: projectedBlocks,
    lifecycleByBlock: Object.fromEntries(
      [...lifecycleByBlock.entries()].map(([blockId, lifecycle]) => [
        blockId,
        projectLifecycleFields(lifecycle),
      ]),
    ),
  });
}

export function cadenceBlockLifecycleById(input = {}) {
  const date = input.date ? dayKey(input.date) : undefined;
  const now = input.now === undefined || input.now === null
    ? undefined
    : dateFrom(typeof input.now === 'function' ? input.now() : input.now, 'now');
  const acts = normalizeLifecycleActs(input.acts ?? [], date);
  const states = new Map();

  for (const act of acts.sort(compareLifecycleActs)) {
    const state = cloneLifecycleState(states.get(act.blockId) ?? defaultLifecycleState());
    applyLifecycleAct(state, act);
    states.set(act.blockId, state);
  }

  if (now) {
    for (const [blockId, state] of states.entries()) {
      states.set(blockId, stateWithRunningElapsed(state, now));
    }
  }

  return states;
}

export function normalizeCadenceActionState(value) {
  const state = requiredString(value, 'actionState').toLowerCase().replace(/-/g, '_');
  if (state === 'complete' || state === 'done') return 'completed';
  if (state === 'active' || state === 'running') return 'started';
  if (CADENCE_BLOCK_ACTION_STATES.includes(state)) return state;
  throw new Error(`invalid cadence action state: ${state}`);
}

function normalizeBlockAct(input, now) {
  if (!isPlainObject(input)) throw new Error('cadence block act must be an object');
  const action = normalizeBlockAction(input.action ?? input.act ?? input.outcome);
  const blockId = requiredString(input.blockId ?? input.id, 'blockId');
  const date = dayKey(input.date ?? input.day ?? input.eventAt ?? now);
  const eventAt = iso(input.eventAt ?? input.actedAt ?? now);
  const id = optionalString(input.id) ?? blockActId({ blockId, date, action, eventAt });
  const twsAnswer = action === 'tws_yes' ? true : action === 'tws_no' ? false : undefined;
  return deepFreeze(stripUndefined({
    id,
    kind: 'CadenceBlockAct',
    schemaVersion: SCHEMA_VERSION,
    date,
    blockId,
    action,
    outcome: blockActionOutcome(action),
    twsAnswer,
    extensionMinutes: action === 'extend_15' ? 15 : undefined,
    actionState: optionalActionState(input.actionState) ?? blockActionState(action),
    startedAt: optionalIso(input.startedAt, 'startedAt'),
    elapsedMinutes: optionalElapsedMinutes(input.elapsedMinutes),
    eventAt,
    source: optionalString(input.source) ?? 'cadence-home',
    note: boundedOptionalText(input.note, 'note', NOTE_MAX_CHARS),
  }));
}

function normalizeLoadedBlockAct(value) {
  if (!isPlainObject(value)) throw new Error('cadence act record must be an object');
  return deepFreeze(stripUndefined({
    id: requiredString(value.id, 'id'),
    kind: 'CadenceBlockAct',
    schemaVersion: SCHEMA_VERSION,
    date: dayKey(value.date),
    blockId: requiredString(value.blockId, 'blockId'),
    action: normalizeBlockAction(value.action),
    outcome: blockActionOutcome(normalizeBlockAction(value.action)),
    twsAnswer: value.twsAnswer === true ? true : value.twsAnswer === false ? false : undefined,
    extensionMinutes: normalizeBlockAction(value.action) === 'extend_15' ? 15 : undefined,
    actionState: optionalActionState(value.actionState) ?? blockActionState(normalizeBlockAction(value.action)),
    startedAt: optionalIso(value.startedAt, 'startedAt'),
    elapsedMinutes: optionalElapsedMinutes(value.elapsedMinutes),
    eventAt: iso(value.eventAt),
    source: optionalString(value.source) ?? 'cadence-home',
    note: boundedOptionalText(value.note, 'note', NOTE_MAX_CHARS),
  }));
}

function normalizeBlockAction(value) {
  const action = requiredString(value, 'action').toLowerCase().replace(/-/g, '_');
  if (action === 'begin') return 'start';
  if (action === 'started') return 'start';
  if (action === 'resume') return 'start';
  if (action === 'resumed') return 'start';
  if (action === 'paused') return 'pause';
  if (action === 'done') return 'complete';
  if (action === 'completed') return 'complete';
  if (action === 'skipped') return 'skip';
  if (action === '+15') return 'extend_15';
  if (action === 'extend15') return 'extend_15';
  if (action === 'plus15') return 'extend_15';
  if (action === 'tws_y') return 'tws_yes';
  if (action === 'well_spent_yes') return 'tws_yes';
  if (action === 'yes') return 'tws_yes';
  if (action === 'tws_n') return 'tws_no';
  if (action === 'well_spent_no') return 'tws_no';
  if (action === 'no') return 'tws_no';
  if (action === 'noresponse') return 'no_response';
  if (action === 'unanswered') return 'no_response';
  if (!CADENCE_BLOCK_ACTS.includes(action)) throw new Error(`invalid cadence block action: ${action}`);
  return action;
}

function blockActionOutcome(action) {
  if (action === 'start') return 'started';
  if (action === 'pause') return 'paused';
  if (action === 'complete') return 'completed';
  if (action === 'skip') return 'skipped';
  if (action === 'extend_15') return 'extended';
  if (action === 'tws_yes') return 'well_spent';
  if (action === 'tws_no') return 'not_well_spent';
  return 'no_response';
}

function blockActionState(action) {
  if (action === 'start') return 'started';
  if (action === 'pause') return 'available';
  if (action === 'complete' || action === 'skip') return 'completed';
  return undefined;
}

function normalizeLifecycleActs(acts, date) {
  if (!Array.isArray(acts)) throw new Error('acts must be an array');
  return acts
    .map(normalizeLifecycleAct)
    .filter((act) => !date || act.date === date);
}

function normalizeLifecycleAct(value) {
  if (!isPlainObject(value)) throw new Error('cadence act record must be an object');
  const action = normalizeBlockAction(value.action ?? value.act ?? value.outcome);
  const blockId = requiredString(value.blockId ?? value.id, 'blockId');
  const date = dayKey(value.date ?? value.day ?? value.eventAt);
  const eventAt = iso(value.eventAt ?? value.actedAt, 'eventAt');
  return {
    id: optionalString(value.id) ?? blockActId({ blockId, date, action, eventAt }),
    date,
    blockId,
    action,
    eventAt,
  };
}

function defaultLifecycleState() {
  return {
    actionState: 'available',
    startedAt: undefined,
    elapsedMinutes: 0,
    completedAt: undefined,
  };
}

function lifecycleFromBlock(block, { now } = {}) {
  const actionState = optionalActionState(block?.actionState) ?? 'available';
  const startedAt = actionState === 'started'
    ? optionalIso(block?.startedAt, 'startedAt')
    : undefined;
  const state = {
    actionState,
    startedAt,
    elapsedMinutes: optionalElapsedMinutes(block?.elapsedMinutes) ?? 0,
    completedAt: undefined,
  };
  return now ? stateWithRunningElapsed(state, now) : state;
}

function cloneLifecycleState(state) {
  return {
    actionState: state.actionState,
    startedAt: state.startedAt,
    elapsedMinutes: state.elapsedMinutes,
    completedAt: state.completedAt,
  };
}

function applyLifecycleAct(state, act) {
  if (!LIFECYCLE_ACTIONS.has(act.action)) return;
  if (state.actionState === 'completed' && act.action !== 'complete' && act.action !== 'skip') return;

  if (act.action === 'start') {
    if (state.actionState !== 'started') {
      state.actionState = 'started';
      state.startedAt = act.eventAt;
    }
    return;
  }

  if (act.action === 'pause') {
    if (state.actionState === 'started' && state.startedAt) {
      state.elapsedMinutes += elapsedMinutesBetween(state.startedAt, act.eventAt);
    }
    state.actionState = 'available';
    state.startedAt = undefined;
    return;
  }

  if (state.actionState === 'started' && state.startedAt) {
    state.elapsedMinutes += elapsedMinutesBetween(state.startedAt, act.eventAt);
  }
  state.actionState = 'completed';
  state.startedAt = undefined;
  state.completedAt = act.eventAt;
}

function stateWithRunningElapsed(state, now) {
  const projected = cloneLifecycleState(state);
  if (projected.actionState === 'started' && projected.startedAt) {
    projected.elapsedMinutes += elapsedMinutesBetween(projected.startedAt, now);
  }
  return projected;
}

function projectLifecycleFields(state) {
  return stripUndefined({
    actionState: normalizeCadenceActionState(state.actionState ?? 'available'),
    startedAt: state.actionState === 'started' ? optionalIso(state.startedAt, 'startedAt') : undefined,
    elapsedMinutes: optionalElapsedMinutes(state.elapsedMinutes) ?? 0,
  });
}

function optionalActionState(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeCadenceActionState(value);
}

function optionalElapsedMinutes(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('elapsedMinutes must be a non-negative number');
  return Math.floor(number);
}

function optionalIso(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return iso(value, label);
}

function elapsedMinutesBetween(startAt, endAt) {
  const start = dateFrom(startAt, 'startedAt').getTime();
  const end = dateFrom(endAt, 'eventAt').getTime();
  if (end <= start) return 0;
  return Math.floor((end - start) / 60_000);
}

function compareLifecycleActs(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.eventAt.localeCompare(b.eventAt) ||
    a.id.localeCompare(b.id)
  );
}

function normalizeBackfillItem(input) {
  const date = dayKey(input.date);
  const blockId = requiredString(input.blockId, 'blockId');
  const status = normalizeBackfillStatus(input.status ?? 'pending');
  return deepFreeze(stripUndefined({
    id: optionalString(input.id) ?? backfillId(date, blockId),
    kind: 'CadenceEveningBackfillItem',
    schemaVersion: SCHEMA_VERSION,
    date,
    blockId,
    prompt: 'well spent?',
    status,
    createdAt: iso(input.createdAt ?? input.eventAt ?? new Date()),
    dueAt: iso(input.dueAt ?? eveningDueAt(date)),
    resolvedAt: status === 'pending' ? undefined : iso(input.resolvedAt ?? input.updatedAt ?? new Date()),
    updatedAt: iso(input.updatedAt ?? input.createdAt ?? new Date()),
  }));
}

function normalizeLoadedBackfillItem(value) {
  if (!isPlainObject(value)) throw new Error('backfill item must be an object');
  return normalizeBackfillItem(value);
}

function normalizeBackfillStatus(value) {
  const status = requiredString(value, 'status');
  if (!BACKFILL_STATUSES.includes(status)) throw new Error(`invalid backfill status: ${status}`);
  return status;
}

function normalizeNudgeDisposition(input, now) {
  if (!isPlainObject(input)) throw new Error('nudge disposition must be an object');
  const date = dayKey(input.date ?? input.eventAt ?? now);
  const eventAt = iso(input.eventAt ?? now);
  const nudgeId = requiredString(input.nudgeId ?? input.id, 'nudgeId');
  const blockId = requiredString(input.blockId ?? input.affectedBlockId ?? input.targetBlockId, 'blockId');
  const disposition = normalizeNudgeDispositionValue(input.disposition ?? input.action);
  return deepFreeze(stripUndefined({
    id: optionalString(input.id) ?? nudgeDispositionId({ date, blockId, nudgeId, disposition, eventAt }),
    kind: 'CadenceNudgeDisposition',
    schemaVersion: SCHEMA_VERSION,
    date,
    nudgeId,
    blockId,
    disposition,
    reason: optionalString(input.reason),
    eventAt,
    source: optionalString(input.source) ?? 'cadence-home',
    note: boundedOptionalText(input.note, 'note', NOTE_MAX_CHARS),
  }));
}

function normalizeLoadedNudgeDisposition(value) {
  if (!isPlainObject(value)) throw new Error('nudge disposition record must be an object');
  return deepFreeze(stripUndefined({
    id: requiredString(value.id, 'id'),
    kind: 'CadenceNudgeDisposition',
    schemaVersion: SCHEMA_VERSION,
    date: dayKey(value.date),
    nudgeId: requiredString(value.nudgeId, 'nudgeId'),
    blockId: requiredString(value.blockId, 'blockId'),
    disposition: normalizeNudgeDispositionValue(value.disposition),
    reason: optionalString(value.reason),
    eventAt: iso(value.eventAt),
    source: optionalString(value.source) ?? 'cadence-home',
    note: boundedOptionalText(value.note, 'note', NOTE_MAX_CHARS),
  }));
}

function normalizeNudgeCandidate(value, date) {
  if (!isPlainObject(value)) return null;
  const id = optionalString(value.id ?? value.nudgeId);
  const blockId = optionalString(value.affectedBlockId ?? value.blockId ?? value.targetBlockId);
  if (!id || !blockId) return null;
  const disposition = normalizeNudgeDispositionValue(value.disposition ?? 'act');
  return stripUndefined({
    id,
    blockId,
    title: boundedOptionalText(value.title ?? value.summary, 'title', TITLE_MAX_CHARS),
    body: boundedOptionalText(value.body ?? value.text, 'body', NOTE_MAX_CHARS),
    category: optionalString(value.category),
    disposition,
    score: finiteNumber(value.score ?? value.rankScore ?? value.priority, 0),
    urgency: finiteNumber(value.urgency, 0),
    createdAt: iso(value.createdAt ?? value.eventAt ?? `${date}T00:00:00.000Z`),
    source: optionalString(value.source),
    cardId: optionalString(value.cardId ?? value.buildCardId),
    optionId: optionalString(value.optionId ?? value.answerOption),
    act: clonePlainObject(value.act ?? value.action),
    buildCard: clonePlainObject(value.buildCard),
  });
}

function normalizeNudgeDispositionValue(value) {
  const disposition = requiredString(value, 'disposition').toLowerCase();
  if (!CADENCE_NUDGE_DISPOSITIONS.includes(disposition)) {
    throw new Error(`invalid nudge disposition: ${disposition}`);
  }
  return disposition;
}

function normalizeSuppressedToday(input, now) {
  const normalized = normalizeSuppressedTodayInput(input);
  return deepFreeze(stripUndefined({
    ...normalized,
    eventAt: iso(normalized.eventAt ?? now),
  }));
}

function normalizeSuppressedTodayInput(input) {
  if (!isPlainObject(input)) throw new Error('suppressed-today record must be an object');
  const date = dayKey(input.date ?? input.eventAt ?? new Date());
  const blockId = requiredString(input.blockId ?? input.affectedBlockId ?? input.targetBlockId, 'blockId');
  const nudgeId = requiredString(input.nudgeId ?? input.id, 'nudgeId');
  return stripUndefined({
    id: optionalString(input.id) ?? suppressedTodayId(date, blockId, nudgeId),
    kind: 'CadenceSuppressedToday',
    schemaVersion: SCHEMA_VERSION,
    date,
    nudgeId,
    blockId,
    title: boundedOptionalText(input.title, 'title', TITLE_MAX_CHARS),
    reason: optionalString(input.reason) ?? 'suppressed',
    source: optionalString(input.source) ?? 'cadence-home',
    eventAt: input.eventAt ? iso(input.eventAt) : undefined,
  });
}

function normalizeLoadedSuppressedToday(value) {
  if (!isPlainObject(value)) throw new Error('suppressed-today record must be an object');
  return normalizeSuppressedTodayInput(value);
}

function suppressedFromDisposition(record) {
  return {
    date: record.date,
    blockId: record.blockId,
    nudgeId: record.nudgeId,
    reason: record.reason ?? 'disposition_suppress',
    source: record.source,
    eventAt: record.eventAt,
  };
}

function projectRankedNudge(candidate) {
  return stripUndefined({
    id: candidate.id,
    blockId: candidate.blockId,
    title: candidate.title,
    body: candidate.body,
    category: candidate.category,
    disposition: candidate.disposition,
    score: candidate.score,
    urgency: candidate.urgency,
    createdAt: candidate.createdAt,
    source: candidate.source,
    cardId: candidate.cardId,
    optionId: candidate.optionId,
    act: clonePlainObject(candidate.act),
    buildCard: clonePlainObject(candidate.buildCard),
    rank: candidate.rank,
    placement: candidate.placement,
  });
}

function normalizeBlockIds(input, options = {}) {
  const fromBlocks = Array.isArray(input.blocks)
    ? input.blocks.map((block) => block?.id ?? block?.blockId)
    : [];
  const raw = [
    ...fromBlocks,
    ...(Array.isArray(input.blockIds) ? input.blockIds : []),
  ];
  const ids = uniqueStrings(raw);
  if (ids.length === 0 && !options.allowEmpty) throw new Error('at least one block is required');
  return ids;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = optionalString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function compareBlockActs(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.eventAt.localeCompare(b.eventAt) ||
    a.id.localeCompare(b.id)
  );
}

function compareBackfillItems(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function compareNudgeDispositions(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.eventAt.localeCompare(b.eventAt) ||
    a.nudgeId.localeCompare(b.nudgeId) ||
    a.id.localeCompare(b.id)
  );
}

function compareSuppressedToday(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.nudgeId.localeCompare(b.nudgeId) ||
    String(a.eventAt ?? '').localeCompare(String(b.eventAt ?? '')) ||
    a.id.localeCompare(b.id)
  );
}

function compareNudgeCandidates(a, b) {
  return (
    nudgeDispositionRank(a.disposition) - nudgeDispositionRank(b.disposition) ||
    b.score - a.score ||
    b.urgency - a.urgency ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function nudgeDispositionRank(disposition) {
  if (disposition === 'act') return 0;
  if (disposition === 'watch') return 1;
  return 2;
}

async function listJsonRecords(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function blockActId({ blockId, date, action, eventAt }) {
  const stableParts = TWS_ACTIONS.has(action)
    ? [date, blockId, 'tws']
    : [date, blockId, action, eventAt];
  return cadenceId('cadact', stableParts);
}

function backfillId(date, blockId) {
  return cadenceId('cadbf', [date, blockId]);
}

function nudgeDispositionId({ date, blockId, nudgeId, disposition, eventAt }) {
  return cadenceId('cadnd', [date, blockId, nudgeId, disposition, eventAt]);
}

function suppressedTodayId(date, blockId, nudgeId) {
  return cadenceId('cadns', [date, blockId, nudgeId]);
}

function cadenceId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(stableJson(parts)).digest('hex').slice(0, 24)}`;
}

function suppressedKey(date, nudgeId, blockId) {
  const normalizedNudgeId = optionalString(nudgeId);
  const normalizedBlockId = optionalString(blockId);
  if (!normalizedNudgeId || !normalizedBlockId) return '';
  return `${date}:${normalizedBlockId}:${normalizedNudgeId}`;
}

function eveningDueAt(date) {
  return `${dayKey(date)}T18:00:00.000Z`;
}

function boundedOptionalText(value, label, maxChars) {
  const text = optionalString(value);
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function finiteNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function iso(value, label = 'date') {
  return dateFrom(value, label).toISOString();
}

function dateFrom(value, label = 'date') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function dayKey(value) {
  const text = optionalString(value);
  if (text && /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return iso(value, 'date').slice(0, 10);
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) return undefined;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > NUDGE_ACTION_MAX_BYTES) return undefined;
  return JSON.parse(json);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeNow(value) {
  if (typeof value === 'function') return value;
  if (value !== undefined && value !== null) return () => value;
  return () => new Date();
}
