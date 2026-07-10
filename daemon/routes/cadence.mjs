import {
  CADENCE_REVIEW_CARDS_PATH,
  CADENCE_TWS_BACKFILL_PATH,
  CADENCE_TWS_NO_RESPONSE_PATH,
  CADENCE_VALUE_PROBE_ANSWERS_PATH,
  REVIEW_CARD_TYPE_EVENING,
  createReviewCadenceStore,
  persistTwsNoResponseOutcomes,
  recordValueProbeAnswers,
  recordTwsBackfillAnswers,
  weeklyRetroWithValueAnchorsFromDataDir,
} from '../../src/agent/review-cadences.mjs';
import {
  createCadenceActStore,
  normalizeCadenceActionState,
  projectCadenceBlockLifecycle,
} from '../../src/agent/cadence-acts.mjs';
import {
  BuildCardError,
  InvalidChannelError,
  buildCardCadenceNudges,
  buildCardIdFromCadenceNudgeId,
  createBuildCardStore,
} from '../../src/agent/build-cards.mjs';
import {
  assertCadenceOpsBlock,
  populateCadenceOpsBlocks,
} from '../../src/agent/cadence.mjs';
import { recomputeCadenceNowNext } from '../../src/agent/cadence-engine.mjs';
import {
  detectCadenceRecalibrationTrigger,
  isOverrunRecalibrationAction,
  isWakeInitAct,
  loadCadenceRecalibrationAnchor,
  recalibrateCadenceBlocks,
  saveCadenceRecalibrationAnchor,
} from '../../src/agent/cadence-recalibrate.mjs';
import { createOpsGroupStore } from '../../src/agent/ops-groups.mjs';
import {
  ATTENTION_MODES,
  RINGS,
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../../src/substrate.mjs';

export const CADENCE_DAY_PATH = '/api/cadence/day';
export const CADENCE_BANDISH_PATH = '/api/cadence/bandish';
export const CADENCE_CAPACITY_BUDGETS_PATH = '/api/cadence/capacity-budgets';
export const CADENCE_RETRO_PATH = '/api/cadence/retro';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MODE_RANK = new Map(ATTENTION_MODES.map((mode, index) => [mode, index]));
const RING_RANK = new Map(RINGS.map((ring, index) => [ring, index]));
const READONLY_FIELDS = Object.freeze([
  'id',
  'kind',
  'schemaVersion',
  'dedupeKey',
  'validFrom',
  'validTo',
  'ingestedAt',
  'supersededById',
]);

export function isCadencePath(pathname) {
  return Boolean(
    pathname === CADENCE_DAY_PATH ||
    cadenceId(pathname, CADENCE_BANDISH_PATH) ||
    cadenceId(pathname, CADENCE_CAPACITY_BUDGETS_PATH) ||
    pathname === CADENCE_BANDISH_PATH ||
    pathname === CADENCE_CAPACITY_BUDGETS_PATH
  );
}

export async function handleCadenceRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.store ??
    createSubstrateStore({ dataDir: context.dataDir, now: context.now });
  const searchParams = context.searchParams ??
    new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;

  if (pathname === CADENCE_DAY_PATH) {
    if (method === 'GET') {
      let date;
      try {
        date = dayParam(searchParams, context.now);
      } catch {
        throw httpError(400, 'invalid_day');
      }
      sendJson(response, 200, {
        ok: true,
        ...(await cadenceDay(store, date, context)),
        generatedAt: isoNow(context.now),
        source: 'cs-k',
      });
      return true;
    }

    if (method === 'POST' || method === 'PUT') {
      const payload = await readPlaintextJson(request);
      const result = await upsertCadenceDay(store, payload, httpError, context);
      sendJson(response, 200, {
        ok: true,
        ...result,
        generatedAt: isoNow(context.now),
        source: 'cs-k',
      });
      return true;
    }
  }

  const bandishId = cadenceId(pathname, CADENCE_BANDISH_PATH);
  if (pathname === CADENCE_BANDISH_PATH || bandishId) {
    if (method === 'GET' && !bandishId) {
      const records = await bandishRecords(store, searchParams, httpError);
      sendJson(response, 200, {
        ok: true,
        count: records.length,
        sort: ['startAt', 'endAt', 'ring', 'attentionMode'],
        records: records.map(projectBandish),
      });
      return true;
    }

    if (method === 'POST' && !bandishId) {
      const payload = await readPlaintextJson(request);
      const result = await createBandish(store, payload, httpError);
      sendJson(response, 200, {
        ok: true,
        created: result.created,
        record: projectBandish(result.record),
      });
      return true;
    }

    if (method === 'GET' && bandishId) {
      const record = await readKindRecord(store, bandishId, 'Bandish', httpError);
      sendJson(response, 200, { ok: true, record: projectBandish(record) });
      return true;
    }

    if ((method === 'PATCH' || method === 'PUT') && bandishId) {
      const payload = await readPlaintextJson(request);
      const result = await replaceBandish(store, bandishId, payload, httpError);
      sendJson(response, 200, {
        ok: true,
        updated: result.newRecord.id !== result.oldRecord.id,
        record: projectBandish(result.newRecord),
        oldRecord: projectBandish(result.oldRecord),
      });
      return true;
    }

    if (method === 'DELETE' && bandishId) {
      const result = await retireKindRecord(store, bandishId, 'Bandish', httpError);
      sendJson(response, 200, {
        ok: true,
        retired: result.retired,
        record: projectBandish(result.record),
      });
      return true;
    }
  }

  const budgetId = cadenceId(pathname, CADENCE_CAPACITY_BUDGETS_PATH);
  if (pathname === CADENCE_CAPACITY_BUDGETS_PATH || budgetId) {
    if (method === 'GET' && !budgetId) {
      const records = await capacityBudgetRecords(store, searchParams, httpError);
      sendJson(response, 200, {
        ok: true,
        count: records.length,
        sort: ['day', 'attentionMode'],
        records: records.map(projectCapacityBudget),
      });
      return true;
    }

    if (method === 'POST' && !budgetId) {
      const payload = await readPlaintextJson(request);
      const result = await createCapacityBudget(store, payload, httpError);
      sendJson(response, 200, {
        ok: true,
        created: result.created,
        record: projectCapacityBudget(result.record),
      });
      return true;
    }

    if (method === 'GET' && budgetId) {
      const record = await readKindRecord(store, budgetId, 'CapacityBudget', httpError);
      sendJson(response, 200, { ok: true, record: projectCapacityBudget(record) });
      return true;
    }

    if ((method === 'PATCH' || method === 'PUT') && budgetId) {
      const payload = await readPlaintextJson(request);
      const result = await replaceCapacityBudget(store, budgetId, payload, httpError);
      sendJson(response, 200, {
        ok: true,
        updated: result.newRecord.id !== result.oldRecord.id,
        record: projectCapacityBudget(result.newRecord),
        oldRecord: projectCapacityBudget(result.oldRecord),
      });
      return true;
    }

    if (method === 'DELETE' && budgetId) {
      const result = await retireKindRecord(store, budgetId, 'CapacityBudget', httpError);
      sendJson(response, 200, {
        ok: true,
        retired: result.retired,
        record: projectCapacityBudget(result.record),
      });
      return true;
    }
  }

  if (isCadencePath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

async function upsertCadenceDay(store, payload, httpError, context = {}) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_cadence_day_payload');
  rejectClientPathFields(payload, httpError);
  let date;
  let bandishInputs;
  let budgetInputs;
  try {
    date = normalizeDateOnly(payload.date ?? payload.day, 'date');
    bandishInputs = collection(payload.bandish ?? payload.blocks ?? [], 'bandish');
    budgetInputs = capacityBudgetInputs(
      payload.capacityBudgets ?? payload.budgets ?? payload.capacityByMode ?? [],
    );
  } catch {
    throw httpError(400, 'invalid_cadence_day');
  }
  const bandish = [];
  const capacityBudgets = [];

  try {
    for (const input of bandishInputs) {
      if (!isPlainObject(input)) throw new Error('invalid bandish item');
      rejectClientPathFields(input, httpError);
      const id = optionalString(input.id);
      rejectReadonlyFields(input, httpError, { allowId: true });
      if (id) {
        const { id: _id, ...patch } = input;
        const result = await replaceBandish(store, id, { ...patch, day: input.day ?? date }, httpError);
        bandish.push(result.newRecord);
      } else {
        enforceCadenceOpsWall({ ...input, day: input.day ?? date }, httpError);
        const result = await store.writeBandish(
          withCadenceDefaults({ ...input, day: input.day ?? date }),
          { withWriteResult: true },
        );
        bandish.push(result.record);
      }
    }

    for (const input of budgetInputs) {
      if (!isPlainObject(input)) throw new Error('invalid capacity budget item');
      rejectClientPathFields(input, httpError);
      const id = optionalString(input.id);
      rejectReadonlyFields(input, httpError, { allowId: true });
      if (id) {
        const { id: _id, ...patch } = input;
        const result = await replaceCapacityBudget(
          store,
          id,
          { ...patch, day: input.day ?? date },
          httpError,
        );
        capacityBudgets.push(result.newRecord);
      } else {
        const result = await store.writeCapacityBudget(
          withCadenceDefaults({ ...input, day: input.day ?? date }),
          { withWriteResult: true },
        );
        capacityBudgets.push(result.record);
      }
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, 'invalid_cadence_day');
  }

  return {
    date,
    wrote: {
      bandish: bandish.length,
      capacityBudgets: capacityBudgets.length,
    },
    day: await cadenceDay(store, date, context),
  };
}

async function cadenceDay(store, date, context = {}) {
  const [bandish, capacityBudgets, opsProjection, acts] = await Promise.all([
    liveRecords(store, 'Bandish'),
    liveRecords(store, 'CapacityBudget'),
    loadOpsProjection(context, date),
    loadCadenceActs(context, date),
  ]);
  const dayBandish = bandish
    .filter((record) => record.day === date)
    .sort(compareBandish);
  const dayBudgets = capacityBudgets
    .filter((record) => record.day === date)
    .sort(compareCapacityBudget);

  const populated = populateCadenceOpsBlocks({
    blocks: dayBandish.map(projectBandish),
    opsGroups: opsProjection.opsGroups,
    adminItems: opsProjection.adminItems,
  }).blocks;
  const blocks = projectCadenceBlockLifecycle({
    date,
    blocks: populated,
    acts,
    now: context.now,
  }).blocks;
  const recalibrated = await recalibrateDayBlocksForRoute({ blocks, date, context });
  const dayBlocks = recalibrated.blocks;

  return {
    date,
    bandish: dayBlocks,
    blocks: dayBlocks,
    capacityBudgets: dayBudgets.map(projectCapacityBudget),
    capacityByMode: capacityByMode(dayBudgets),
    remainingCapacity: remainingCapacity(dayBudgets, dayBlocks, context.now),
    ...recalibrated.payload,
  };
}

async function recalibrateDayBlocksForRoute({ blocks, date, context }) {
  const anchor = await loadCadenceRecalibrationAnchor({
    dataDir: context.dataDir,
    date,
  });
  if (!anchor) return { blocks, payload: {} };

  const result = recalibrateCadenceBlocks({
    blocks,
    now: anchor.anchorAt,
    trigger: anchor.trigger,
    reason: anchor.reason,
  });
  if (!result.changed) return { blocks, payload: {} };
  return {
    blocks: result.blocks,
    payload: {
      recalibration: result.recalibration,
      recalibrationChanges: result.changes,
    },
  };
}

async function loadOpsProjection(context, date) {
  const opsStore = context.opsStore ?? createOpsGroupStore({
    dataDir: context.dataDir,
    now: context.now,
  });
  const [opsGroups, adminItems] = await Promise.all([
    opsStore.listOpsGroupChecklists({ date }),
    opsStore.listAdminItems({ status: 'open' }),
  ]);
  return { opsGroups, adminItems };
}

async function loadCadenceActs(context, date) {
  const store = context.cadenceActStore ??
    createCadenceActStore({ dataDir: context.dataDir, now: context.now });
  return store.listBlockActs({ date });
}

async function bandishRecords(store, searchParams, httpError) {
  const date = optionalDayParam(searchParams, httpError);
  const attentionMode = optionalEnumParam(searchParams, 'attentionMode', ATTENTION_MODES, httpError);
  const ring = optionalEnumParam(searchParams, 'ring', RINGS, httpError);
  const includeRetired = searchParams?.get?.('all') === 'true';
  const limit = limitParam(searchParams, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const records = await store.listRecords('Bandish');

  return records
    .filter((record) => includeRetired || isLiveRecord(record))
    .filter((record) => !date || record.day === date)
    .filter((record) => !attentionMode || record.attentionMode === attentionMode)
    .filter((record) => !ring || record.ring === ring)
    .sort(compareBandish)
    .slice(0, limit);
}

async function capacityBudgetRecords(store, searchParams, httpError) {
  const date = optionalDayParam(searchParams, httpError);
  const attentionMode = optionalEnumParam(searchParams, 'attentionMode', ATTENTION_MODES, httpError);
  const includeRetired = searchParams?.get?.('all') === 'true';
  const limit = limitParam(searchParams, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const records = await store.listRecords('CapacityBudget');

  return records
    .filter((record) => includeRetired || isLiveRecord(record))
    .filter((record) => !date || record.day === date)
    .filter((record) => !attentionMode || record.attentionMode === attentionMode)
    .sort(compareCapacityBudget)
    .slice(0, limit);
}

async function createBandish(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_bandish_payload');
  rejectClientPathFields(payload, httpError);
  rejectReadonlyFields(payload, httpError);
  enforceCadenceOpsWall(payload, httpError);

  try {
    return await store.writeBandish(withCadenceDefaults(payload), { withWriteResult: true });
  } catch {
    throw httpError(400, 'invalid_bandish');
  }
}

async function createCapacityBudget(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_capacity_budget_payload');
  rejectClientPathFields(payload, httpError);
  rejectReadonlyFields(payload, httpError);

  try {
    return await store.writeCapacityBudget(withCadenceDefaults(payload), { withWriteResult: true });
  } catch {
    throw httpError(400, 'invalid_capacity_budget');
  }
}

async function replaceBandish(store, id, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_bandish_payload');
  rejectClientPathFields(payload, httpError);
  rejectReadonlyFields(payload, httpError);
  const existing = await readKindRecord(store, id, 'Bandish', httpError);
  const nextInput = {
    ...bandishInput(existing),
    ...payload,
    provenance: payload.provenance ?? existing.provenance,
  };
  enforceCadenceOpsWall(nextInput, httpError);

  try {
    return await store.supersedeRecord(existing.id, withCadenceDefaults(nextInput));
  } catch {
    throw httpError(400, 'invalid_bandish');
  }
}

async function replaceCapacityBudget(store, id, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_capacity_budget_payload');
  rejectClientPathFields(payload, httpError);
  rejectReadonlyFields(payload, httpError);
  const existing = await readKindRecord(store, id, 'CapacityBudget', httpError);

  try {
    return await store.supersedeRecord(existing.id, {
      ...capacityBudgetInput(existing),
      ...payload,
      provenance: payload.provenance ?? existing.provenance,
    });
  } catch {
    throw httpError(400, 'invalid_capacity_budget');
  }
}

async function retireKindRecord(store, id, kind, httpError) {
  await readKindRecord(store, id, kind, httpError);
  return store.retireRecord(id, { withWriteResult: true });
}

async function readKindRecord(store, id, kind, httpError) {
  const record = await store.readRecord(id);
  if (!record || record.kind !== kind) throw httpError(404, 'record_not_found');
  return record;
}

async function liveRecords(store, kind) {
  return (await store.listRecords(kind)).filter(isLiveRecord);
}

function projectBandish(record) {
  const metadata = isPlainObject(record.metadata) ? record.metadata : {};
  return stripUndefined({
    id: record.id,
    kind: record.kind,
    blockType: optionalString(record.blockType ?? metadata.blockType ?? metadata.type),
    day: record.day,
    startAt: record.startAt,
    endAt: record.endAt,
    attentionMode: record.attentionMode,
    ring: record.ring,
    opsBlock: record.opsBlock === true || metadata.opsBlock === true ? true : undefined,
    description: record.description,
    type: optionalString(record.type),
    why: optionalString(record.why),
    detail: isPlainObject(record.detail) ? record.detail : undefined,
    sourceId: record.sourceId,
    actionState: normalizeOptionalActionState(record.actionState ?? metadata.actionState),
    startedAt: optionalIso(record.startedAt ?? metadata.startedAt),
    elapsedMinutes: optionalElapsedMinutes(record.elapsedMinutes ?? metadata.elapsedMinutes),
    metadata: record.metadata,
    provenance: record.provenance,
    eventAt: record.eventAt,
    ingestedAt: record.ingestedAt,
    validFrom: record.validFrom,
    validTo: record.validTo,
    supersededById: record.supersededById,
  });
}

function projectCapacityBudget(record) {
  return stripUndefined({
    id: record.id,
    kind: record.kind,
    day: record.day,
    attentionMode: record.attentionMode,
    minutes: record.minutes,
    sourceId: record.sourceId,
    metadata: record.metadata,
    provenance: record.provenance,
    eventAt: record.eventAt,
    ingestedAt: record.ingestedAt,
    validFrom: record.validFrom,
    validTo: record.validTo,
    supersededById: record.supersededById,
  });
}

function bandishInput(record) {
  const metadata = isPlainObject(record.metadata) ? record.metadata : {};
  return {
    day: record.day,
    startAt: record.startAt,
    endAt: record.endAt,
    attentionMode: record.attentionMode,
    ring: record.ring,
    blockType: optionalString(record.blockType ?? metadata.blockType ?? metadata.type),
    opsBlock: record.opsBlock === true || metadata.opsBlock === true ? true : undefined,
    description: record.description,
    type: optionalString(record.type),
    why: optionalString(record.why),
    detail: isPlainObject(record.detail) ? record.detail : undefined,
    sourceId: record.sourceId,
    actionState: normalizeOptionalActionState(record.actionState ?? metadata.actionState),
    startedAt: optionalIso(record.startedAt ?? metadata.startedAt),
    elapsedMinutes: optionalElapsedMinutes(record.elapsedMinutes ?? metadata.elapsedMinutes),
    metadata: record.metadata,
    provenance: record.provenance,
  };
}

function capacityBudgetInput(record) {
  return {
    day: record.day,
    attentionMode: record.attentionMode,
    minutes: record.minutes,
    sourceId: record.sourceId,
    metadata: record.metadata,
    provenance: record.provenance,
  };
}

function withCadenceDefaults(payload) {
  return {
    ...payload,
    metadata: cadenceMetadata(payload),
    provenance: payload.provenance ?? { surface: 'cadence', lane: 'deliberate' },
  };
}

function cadenceMetadata(payload) {
  const metadata = isPlainObject(payload.metadata) ? { ...payload.metadata } : {};
  const blockType = optionalString(payload.blockType);
  if (blockType) metadata.blockType = blockType;
  if (payload.opsBlock === true || payload.isOpsBlock === true || payload.ops === true) {
    metadata.opsBlock = true;
  }
  const lifecycle = cadenceLifecycleMetadata(payload);
  if (lifecycle) Object.assign(metadata, lifecycle);
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function capacityByMode(records) {
  const result = {};
  for (const record of records) {
    result[record.attentionMode] = record.minutes;
  }
  return result;
}

function remainingCapacity(records, blocks, nowInput) {
  const now = dateNow(nowInput).getTime();
  const elapsedByMode = {};

  for (const block of blocks) {
    if (block?.skipped === true) continue;
    const mode = optionalString(block?.attentionMode);
    if (!mode) continue;
    const lifecycleElapsed = lifecycleElapsedMinutes(block);
    if (lifecycleElapsed !== null) {
      elapsedByMode[mode] = (elapsedByMode[mode] ?? 0) + lifecycleElapsed;
      continue;
    }
    const start = Date.parse(block.startAt);
    const end = Date.parse(block.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || now <= start) {
      continue;
    }

    const elapsedMinutes = Math.floor((Math.min(now, end) - start) / 60_000);
    if (elapsedMinutes <= 0) continue;
    elapsedByMode[mode] = (elapsedByMode[mode] ?? 0) + elapsedMinutes;
  }

  const result = {};
  for (const record of records) {
    const mode = optionalString(record?.attentionMode);
    const budget = Number(record?.minutes);
    if (!mode || !Number.isFinite(budget)) continue;
    result[mode] = budget - (elapsedByMode[mode] ?? 0);
  }
  return result;
}

function cadenceLifecycleMetadata(payload) {
  const source = isPlainObject(payload.metadata) ? payload.metadata : {};
  const lifecycle = stripUndefined({
    actionState: normalizeOptionalActionState(payload.actionState ?? source.actionState),
    startedAt: optionalIso(payload.startedAt ?? source.startedAt),
    elapsedMinutes: optionalElapsedMinutes(payload.elapsedMinutes ?? source.elapsedMinutes),
  });
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

function normalizeOptionalActionState(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeCadenceActionState(value);
}

function optionalElapsedMinutes(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('elapsedMinutes must be a non-negative number');
  return Math.floor(number);
}

function optionalIso(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('date must be valid');
  return date.toISOString();
}

function lifecycleElapsedMinutes(block) {
  const elapsed = optionalElapsedMinutes(block?.elapsedMinutes);
  if (elapsed === undefined) return null;
  if (
    elapsed > 0 ||
    block?.actionState === 'started' ||
    block?.actionState === 'completed' ||
    optionalString(block?.startedAt)
  ) {
    return elapsed;
  }
  return null;
}

function compareBandish(a, b) {
  return (
    compareIso(a?.startAt, b?.startAt) ||
    compareIso(a?.endAt, b?.endAt) ||
    rank(RING_RANK, a?.ring) - rank(RING_RANK, b?.ring) ||
    rank(MODE_RANK, a?.attentionMode) - rank(MODE_RANK, b?.attentionMode) ||
    String(a?.description ?? '').localeCompare(String(b?.description ?? '')) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

function compareCapacityBudget(a, b) {
  return (
    String(a?.day ?? '').localeCompare(String(b?.day ?? '')) ||
    rank(MODE_RANK, a?.attentionMode) - rank(MODE_RANK, b?.attentionMode) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

function cadenceId(pathname, basePath) {
  const prefix = `${basePath}/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function dayParam(searchParams, now) {
  const raw = optionalString(searchParams?.get?.('date') ?? searchParams?.get?.('day'));
  return raw ? normalizeDateOnly(raw, 'date') : isoNow(now).slice(0, 10);
}

function optionalDayParam(searchParams, httpError) {
  const raw = optionalString(searchParams?.get?.('date') ?? searchParams?.get?.('day'));
  if (!raw) return null;
  try {
    return normalizeDateOnly(raw, 'date');
  } catch {
    throw httpError(400, 'invalid_day');
  }
}

function normalizeDateOnly(value, label) {
  const raw = optionalString(value);
  if (!raw) throw new Error(`${label} is required`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString().slice(0, 10);
}

function optionalEnumParam(searchParams, name, values, httpError) {
  const value = optionalString(searchParams?.get?.(name));
  if (!value) return null;
  if (!values.includes(value)) throw httpError(400, `invalid_${name}`);
  return value;
}

function collection(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function capacityBudgetInputs(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    return Object.entries(value).map(([attentionMode, minutes]) => ({ attentionMode, minutes }));
  }
  throw new Error('capacityBudgets must be an array or object');
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'cadencePath']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}

function rejectReadonlyFields(payload, httpError, options = {}) {
  for (const field of READONLY_FIELDS) {
    if (field === 'id' && options.allowId === true) continue;
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'readonly_field_not_allowed');
    }
  }
}

function enforceCadenceOpsWall(payload, httpError) {
  if (!hasAdminOpsProjection(payload) && !hasOpsMarker(payload)) return;
  try {
    assertCadenceOpsBlock({
      ...payload,
      id: payload.id ?? payload.blockId ?? 'pending-block',
      blockType: payload.blockType ?? payload.type ?? payload.metadata?.blockType ?? payload.metadata?.type,
      opsBlock: payload.opsBlock === true || payload.metadata?.opsBlock === true ? true : payload.opsBlock,
    });
  } catch {
    throw httpError(400, 'admin_ops_block_refused');
  }
}

function hasAdminOpsProjection(payload) {
  if (!isPlainObject(payload)) return false;
  return [
    'adminItems',
    'adminChecklist',
    'opsChecklist',
    'checklist',
    'adminQueue',
  ].some((field) => Object.hasOwn(payload, field));
}

function hasOpsMarker(payload) {
  if (!isPlainObject(payload)) return false;
  if (payload.opsBlock === true || payload.isOpsBlock === true || payload.ops === true) return true;
  const blockType = optionalString(payload.blockType ?? payload.type ?? payload.metadata?.blockType);
  return ['ops', 'admin-ops', 'operative-ops'].includes(blockType ?? '');
}

function isLiveRecord(record) {
  return isPlainObject(record) && !record.validTo && !record.supersededById;
}

function compareIso(left, right) {
  return sortableDate(left).localeCompare(sortableDate(right));
}

function sortableDate(value) {
  return optionalString(value) ?? '9999-12-31T23:59:59.999Z';
}

function rank(ranks, value) {
  return ranks.get(value) ?? Number.MAX_SAFE_INTEGER;
}

function limitParam(searchParams, name, fallback, max) {
  const raw = searchParams?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), max);
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return date.toISOString();
}

function dateNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}


// ---- c3: acts / backfill / no-response / nudge routes ----
export const CADENCE_ACTS_PATH = '/api/cadence/acts';
export const CADENCE_BACKFILL_PATH = '/api/cadence/backfill';
export const CADENCE_NO_RESPONSE_PATH = '/api/cadence/no-response';
export const CADENCE_NUDGE_PLACEMENT_PATH = '/api/cadence/nudges/place';
export const CADENCE_NUDGE_DISPOSITION_PATH = '/api/cadence/nudges/disposition';
export const CADENCE_SUPPRESSED_TODAY_PATH = '/api/cadence/nudges/suppressed-today';

const CADENCE_PATHS = new Set([
  CADENCE_ACTS_PATH,
  CADENCE_BACKFILL_PATH,
  CADENCE_NO_RESPONSE_PATH,
  CADENCE_NUDGE_PLACEMENT_PATH,
  CADENCE_NUDGE_DISPOSITION_PATH,
  CADENCE_SUPPRESSED_TODAY_PATH,
]);

export function isCadenceActsPath(pathname) {
  return CADENCE_PATHS.has(pathname);
}

// Returns true if it handled the request. deps supplies { sendJson, httpError,
// readPlaintextJson, isSameMachine? } so this module reuses server-owned helpers.
export async function handleCadenceActsRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.cadenceStore ??
    createCadenceActStore({ dataDir: context.dataDir, now: context.now });
  const buildCardStore = context.buildCardStore ??
    createBuildCardStore({ dataDir: context.dataDir, now: context.now });
  const searchParams = context.searchParams ?? new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;

  if (method === 'GET' && pathname === CADENCE_ACTS_PATH) {
    const date = optionalString(searchParams.get('date'));
    const blockId = optionalString(searchParams.get('blockId'));
    const blockIds = blockIdsParam(searchParams);
    if (searchParams.get('summary') === 'true') {
      if (blockIds.length === 0) throw httpError(400, 'missing_block_ids');
      sendJson(response, 200, {
        ok: true,
        summary: await store.summarizeBlockTws({
          date,
          blockIds,
        }),
      });
      return true;
    }
    sendJson(response, 200, {
      ok: true,
      acts: await store.listBlockActs({ date, blockId }),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_ACTS_PATH) {
    const payload = await readPlaintextJson(request);
    assertPayload(payload, httpError, 'invalid_cadence_act');
    rejectClientPathFields(payload, httpError);
    if (isWakeInitAct(payload)) {
      const eventAt = isoNow(payload.eventAt ?? payload.actedAt ?? context.now);
      const date = normalizeDateOnly(payload.date ?? payload.day ?? eventAt, 'date');
      const trigger = stripUndefined({
        type: 'act',
        action: 'wake_init',
        source: optionalString(payload.source) ?? 'cadence-home',
        eventId: optionalString(payload.id ?? payload.eventId),
      });
      const anchor = await saveCadenceRecalibrationAnchor({
        dataDir: context.dataDir,
        date,
        reason: 'wake-init',
        anchorAt: eventAt,
        trigger,
      });
      sendJson(response, 200, {
        ok: true,
        act: {
          kind: 'CadenceDayAct',
          schemaVersion: 1,
          date,
          action: 'wake_init',
          eventAt,
          source: trigger.source,
        },
        recalibration: {
          reason: anchor.reason,
          anchorAt: anchor.anchorAt,
        },
      });
      scheduleCadenceRecompute(context, trigger, {
        date,
        now: () => new Date(eventAt),
      });
      return true;
    }
    const result = await store.recordBlockAct(payload);
    const overrunAnchor = await maybeRecordOverrunRecalibrationAnchor(context, result.record ?? payload);
    sendJson(response, 200, {
      ok: true,
      ...result,
      ...(overrunAnchor ? {
        recalibration: {
          reason: overrunAnchor.reason,
          anchorAt: overrunAnchor.anchorAt,
        },
      } : {}),
    });
    scheduleCadenceRecompute(context, {
      type: 'act',
      blockId: optionalString(result.act?.blockId ?? result.record?.blockId ?? payload.blockId),
      action: optionalString(result.act?.action ?? result.record?.action ?? payload.action),
      eventId: optionalString(result.record?.id),
    }, overrunAnchor ? {
      date: overrunAnchor.date,
      now: () => new Date(overrunAnchor.anchorAt),
    } : undefined);
    return true;
  }

  async function maybeRecordOverrunRecalibrationAnchor(context, act) {
    const action = optionalString(act?.action);
    const blockId = optionalString(act?.blockId);
    if (!blockId || !isOverrunRecalibrationAction(action)) return null;
    const substrateStore = context.substrateStore ?? context.store;
    if (!substrateStore || typeof substrateStore.listRecords !== 'function') return null;

    const eventAt = isoNow(act?.eventAt ?? context.now);
    const date = normalizeDateOnly(act?.date ?? act?.day ?? eventAt, 'date');
    const blocks = (await liveRecords(substrateStore, 'Bandish'))
      .filter((record) => record.day === date)
      .sort(compareBandish)
      .map(projectBandish);
    const trigger = {
      type: 'act',
      blockId,
      action,
      eventId: optionalString(act?.id),
    };
    const detection = detectCadenceRecalibrationTrigger({
      blocks,
      now: eventAt,
      trigger,
    });
    if (detection?.reason !== 'overrun') return null;
    return saveCadenceRecalibrationAnchor({
      dataDir: context.dataDir,
      date,
      reason: 'overrun',
      anchorAt: eventAt,
      trigger,
    });
  }

  if (method === 'GET' && pathname === CADENCE_BACKFILL_PATH) {
    sendJson(response, 200, {
      ok: true,
      queue: await store.listEveningBackfillQueue({
        date: optionalString(searchParams.get('date')),
        status: optionalString(searchParams.get('status')),
      }),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_BACKFILL_PATH) {
    const payload = await readPlaintextJson(request);
    assertPayload(payload, httpError, 'invalid_cadence_backfill');
    rejectClientPathFields(payload, httpError);
    sendJson(response, 200, {
      ok: true,
      ...(await store.queueEveningBackfill(payload)),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_NO_RESPONSE_PATH) {
    const payload = await readPlaintextJson(request);
    assertPayload(payload, httpError, 'invalid_cadence_no_response');
    rejectClientPathFields(payload, httpError);
    sendJson(response, 200, {
      ok: true,
      ...(await store.recordNoResponseOutcomes(payload)),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_NUDGE_PLACEMENT_PATH) {
    const payload = await readPlaintextJson(request);
    assertPayload(payload, httpError, 'invalid_nudge_placement');
    rejectClientPathFields(payload, httpError);
    const blocks = nudgePlacementBlocks(payload);
    const buildNudges = await buildCardNudgesForPlacement(buildCardStore, {
      ...payload,
      blocks,
      now: context.now,
    });
    sendJson(response, 200, {
      ok: true,
      ...(await store.projectNudgesOntoBlocks({
        ...payload,
        blocks,
        nudges: mergeNudgeCandidates(buildNudges, payload.nudges),
      })),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_NUDGE_DISPOSITION_PATH) {
    const payload = await readPlaintextJson(request);
    assertPayload(payload, httpError, 'invalid_nudge_disposition');
    rejectClientPathFields(payload, httpError);
    validateNudgeDispositionPayload(payload, httpError);
    const buildCardAnswer = await answerBuildCardFromCadenceNudge({
      payload,
      cardStore: buildCardStore,
      request,
      deps,
      httpError,
    });
    sendJson(response, 200, {
      ok: true,
      ...(await store.recordNudgeDisposition(payload)),
      buildCardAnswer,
    });
    return true;
  }

  if (method === 'GET' && pathname === CADENCE_NUDGE_DISPOSITION_PATH) {
    sendJson(response, 200, {
      ok: true,
      records: await store.listNudgeDispositions({
        date: optionalString(searchParams.get('date')),
        blockId: optionalString(searchParams.get('blockId')),
        nudgeId: optionalString(searchParams.get('nudgeId')),
      }),
    });
    return true;
  }

  if (method === 'GET' && pathname === CADENCE_SUPPRESSED_TODAY_PATH) {
    sendJson(response, 200, {
      ok: true,
      records: await store.listSuppressedToday({
        date: optionalString(searchParams.get('date')),
        blockId: optionalString(searchParams.get('blockId')),
      }),
    });
    return true;
  }

  if (isCadenceActsPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

function assertPayload(payload, httpError, code) {
  if (!isPlainObject(payload)) throw httpError(400, code);
}

function blockIdsParam(searchParams) {
  const raw = optionalString(searchParams.get('blockIds') ?? searchParams.get('blocks'));
  if (!raw) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

function scheduleCadenceRecompute(context, trigger, options = {}) {
  const recompute = context.recomputeCadenceNowNext ?? recomputeCadenceNowNext;
  Promise.resolve()
    .then(() => recompute({
      dataDir: context.dataDir,
      date: options?.date,
      now: options?.now ?? context.now,
      trigger,
    }))
    .catch((error) => {
      console.error(`[cs-k] cadence recompute trigger failed: ${error.message}`);
    });
}

async function buildCardNudgesForPlacement(cardStore, input) {
  if (!cardStore || typeof cardStore.listCards !== 'function') return [];
  const cards = await cardStore.listCards();
  return buildCardCadenceNudges({
    cards,
    blocks: input.blocks,
    date: input.date ?? input.day,
    now: input.now,
  });
}

function nudgePlacementBlocks(payload) {
  return Array.isArray(payload.blocks)
    ? payload.blocks
    : Array.isArray(payload.bandish)
      ? payload.bandish
      : [];
}

function mergeNudgeCandidates(buildNudges, inputNudges) {
  const merged = new Map();
  for (const nudge of [
    ...(Array.isArray(inputNudges) ? inputNudges : []),
    ...(Array.isArray(buildNudges) ? buildNudges : []),
  ]) {
    const id = optionalString(nudge?.id ?? nudge?.nudgeId);
    const blockId = optionalString(nudge?.blockId ?? nudge?.targetBlockId ?? nudge?.affectedBlockId);
    if (!id || !blockId) continue;
    merged.set(`${blockId}:${id}`, nudge);
  }
  return [...merged.values()];
}

async function answerBuildCardFromCadenceNudge({ payload, cardStore, request, deps, httpError }) {
  const disposition = optionalString(payload.disposition ?? payload.action)?.toLowerCase();
  if (disposition !== 'act') return undefined;

  try {
    const cardId = optionalString(payload.cardId ?? payload.buildCardId) ??
      buildCardIdFromCadenceNudgeId(payload.nudgeId ?? payload.id);
    if (!cardId) return undefined;
    const card = await cardStore.loadCard(cardId);
    if (!card) throw new BuildCardError(`card not found: ${cardId}`, { code: 'card_not_found' });
    const optionId = optionalString(payload.optionId ?? payload.answerOption) ??
      recommendedBuildCardOption(card);
    const result = await cardStore.answerCard({
      cardId,
      optionId,
      surface: optionalString(payload.surface) ?? 'cadence',
      isSameMachine: sameMachineRequest(request, deps),
    });
    return stripUndefined({
      ok: result.ok,
      changed: result.changed,
      alreadyAnswered: result.alreadyAnswered,
      card: projectCadenceBuildCardAnswer(result.card),
    });
  } catch (error) {
    throw cadenceBuildCardRouteError(error, httpError);
  }
}

function validateNudgeDispositionPayload(payload, httpError) {
  const nudgeId = optionalString(payload.nudgeId ?? payload.id);
  const blockId = optionalString(payload.blockId ?? payload.affectedBlockId ?? payload.targetBlockId);
  const disposition = optionalString(payload.disposition ?? payload.action)?.toLowerCase();
  if (!nudgeId || !blockId || !disposition) throw httpError(400, 'invalid_nudge_disposition');
  if (!['act', 'watch', 'suppress'].includes(disposition)) throw httpError(400, 'invalid_nudge_disposition');
  try {
    if (payload.date !== undefined && payload.date !== null) normalizeDateForRoute(payload.date);
    if (payload.eventAt !== undefined && payload.eventAt !== null) normalizeDateForRoute(payload.eventAt);
  } catch {
    throw httpError(400, 'invalid_nudge_disposition');
  }
}

function normalizeDateForRoute(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid date');
  return date.toISOString();
}

function recommendedBuildCardOption(card) {
  const recommendation = optionalString(card?.recommendation);
  if (recommendation && Array.isArray(card.options) && card.options.some((option) => option?.id === recommendation)) {
    return recommendation;
  }
  return optionalString(Array.isArray(card?.options) ? card.options[0]?.id : undefined);
}

function projectCadenceBuildCardAnswer(card) {
  if (!isPlainObject(card)) return undefined;
  return stripUndefined({
    id: card.id,
    kind: card.kind,
    planId: card.planId,
    unitId: card.unitId,
    laneId: card.laneId,
    status: card.status,
    title: card.title,
    recommendation: card.recommendation,
    answeredBy: card.answeredBy,
    answeredAt: card.answeredAt,
    answerOption: card.answerOption,
    answerSurface: card.answerSurface,
  });
}

function cadenceBuildCardRouteError(error, httpError) {
  if (error instanceof InvalidChannelError) {
    return httpError(403, optionalString(error.code) ?? 'loopback_required');
  }
  if (error instanceof BuildCardError) {
    const code = optionalString(error.code) ?? 'invalid_build_card';
    const status = code.endsWith('_not_found') ? 404 : 400;
    return httpError(status, code);
  }
  return httpError(400, 'invalid_build_card');
}

function sameMachineRequest(request, deps) {
  if (typeof deps.isSameMachine === 'function' && deps.isSameMachine(request) === true) return true;
  const remote = optionalString(request?.socket?.remoteAddress) ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  const local = optionalString(request?.socket?.localAddress) ?? '';
  return Boolean(remote) && remote === local;
}


// ---- r1: review cards / tws backfill / no-response routes ----
const CADENCE_REVIEW_PATHS = new Set([
  CADENCE_RETRO_PATH,
  CADENCE_REVIEW_CARDS_PATH,
  CADENCE_TWS_BACKFILL_PATH,
  CADENCE_TWS_NO_RESPONSE_PATH,
  CADENCE_VALUE_PROBE_ANSWERS_PATH,
]);

export function isCadenceReviewPath(pathname) {
  return CADENCE_REVIEW_PATHS.has(pathname);
}

export async function handleCadenceReviewRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const searchParams = context.searchParams ?? new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
  const store = context.reviewCadenceStore ??
    createReviewCadenceStore({ dataDir: context.dataDir, now: context.now });

  if (method === 'GET' && pathname === CADENCE_RETRO_PATH) {
    sendJson(response, 200, {
      ok: true,
      retro: await weeklyRetroWithValueAnchorsFromDataDir({
        dataDir: context.dataDir,
        now: context.now,
        substrateStore: context.substrateStore ?? context.store,
      }),
    });
    return true;
  }

  if (method === 'GET' && pathname === CADENCE_REVIEW_CARDS_PATH) {
    let cards;
    try {
      cards = await store.listCards({
        date: optionalString(searchParams.get('date')),
        type: optionalString(searchParams.get('type')),
        status: optionalString(searchParams.get('status')) ?? 'open',
      });
    } catch {
      throw httpError(400, 'invalid_review_card_query');
    }
    sendJson(response, 200, {
      ok: true,
      count: cards.length,
      cards: cards.map(projectReviewCard),
    });
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_TWS_BACKFILL_PATH) {
    const payload = await readPlaintextJson(request);
    if (!isPlainObject(payload)) throw httpError(400, 'invalid_tws_backfill_payload');
    try {
      const result = await recordTwsBackfillAnswers({
        dataDir: context.dataDir,
        now: context.now,
        date: optionalString(payload.date),
        answers: payload.answers,
      });
      await store.generateCard(REVIEW_CARD_TYPE_EVENING, {
        date: result.date,
        refresh: true,
      });
      sendJson(response, 200, result);
    } catch {
      throw httpError(400, 'invalid_tws_backfill');
    }
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_TWS_NO_RESPONSE_PATH) {
    const payload = await readPlaintextJson(request);
    if (!isPlainObject(payload)) throw httpError(400, 'invalid_tws_no_response_payload');
    try {
      const result = await persistTwsNoResponseOutcomes({
        dataDir: context.dataDir,
        now: context.now,
        date: optionalString(payload.date),
      });
      await store.generateCard(REVIEW_CARD_TYPE_EVENING, {
        date: result.date,
        refresh: true,
      });
      sendJson(response, 200, result);
    } catch {
      throw httpError(400, 'invalid_tws_no_response');
    }
    return true;
  }

  if (method === 'POST' && pathname === CADENCE_VALUE_PROBE_ANSWERS_PATH) {
    const payload = await readPlaintextJson(request);
    if (!isPlainObject(payload)) throw httpError(400, 'invalid_value_probe_answer_payload');
    try {
      const result = await recordValueProbeAnswers({
        store,
        dataDir: context.dataDir,
        now: context.now,
        cardId: optionalString(payload.cardId ?? payload.id),
        answers: payload.answers,
      });
      sendJson(response, 200, result);
    } catch {
      throw httpError(400, 'invalid_value_probe_answer');
    }
    return true;
  }

  if (isCadenceReviewPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

function projectReviewCard(card) {
  return stripUndefined({
    id: card.id,
    kind: card.kind,
    type: card.type,
    date: card.date,
    title: card.title,
    status: card.status,
    window: card.window,
    sections: card.sections,
    overnightQueue: card.overnightQueue,
    twsBackfill: card.twsBackfill,
    retro: card.retro,
    valueProbes: card.valueProbes,
    generatedAt: card.generatedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    dismissedAt: card.dismissedAt,
  });
}
