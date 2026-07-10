import {
  ADMIN_CONFIRM_PATH,
  ADMIN_INTAKE_PATH,
  ADMIN_ITEMS_PATH,
  commitAdminParseConfirm,
  createAdminStore,
  parseAdminIntakeWithK,
} from '../../src/admin/admin.mjs';
import {
  ADMIN_BANDISH_EFFORTS,
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../../src/substrate.mjs';

export const ADMIN_BANDISH_PATH = '/api/admin/bandish';

const DEFAULT_ADMIN_BANDISH_LIMIT = 100;
const MAX_ADMIN_BANDISH_LIMIT = 500;
const EFFORT_RANK = new Map(ADMIN_BANDISH_EFFORTS.map((effort, index) => [effort, index]));

const ADMIN_INTAKE_PATHS = new Set([
  ADMIN_INTAKE_PATH,
  ADMIN_CONFIRM_PATH,
  ADMIN_ITEMS_PATH,
]);

export function isAdminPath(pathname) {
  return pathname === ADMIN_BANDISH_PATH || ADMIN_INTAKE_PATHS.has(pathname);
}

// Returns true if it handled the request. deps supplies { sendJson, httpError,
// readPlaintextJson } so this module reuses server-owned helpers.
export async function handleAdminRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.store ??
    createSubstrateStore({ dataDir: context.dataDir, now: context.now });
  const searchParams = context.searchParams ?? new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;


  if (method === 'POST' && pathname === ADMIN_INTAKE_PATH) {
    const payload = await readPlaintextJson(request);
    const text = optionalString(payload.text ?? payload.message ?? payload.input);
    if (!text) throw httpError(400, 'empty_intake');
    const result = await parseAdminIntakeWithK(
      { text },
      {
        dataDir: context.dataDir,
        now: context.now,
        runTurn: context.runTurn,
        surface: 'admin_intake',
        deps: context.deps,
      },
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === ADMIN_CONFIRM_PATH) {
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await commitAdminParseConfirm(payload, {
      dataDir: context.dataDir,
      now: context.now,
    }));
    return true;
  }

  if (method === 'GET' && pathname === ADMIN_ITEMS_PATH) {
    const adminStore = createAdminStore({ dataDir: context.dataDir, now: context.now });
    sendJson(response, 200, {
      ok: true,
      items: await adminStore.listBandish(),
    });
    return true;
  }

  if (method === 'GET' && pathname === ADMIN_BANDISH_PATH) {
    const records = await adminBandishRecords(store, searchParams);
    sendJson(response, 200, {
      ok: true,
      count: records.length,
      sort: ['remindAt', 'dueAt', 'effort'],
      records: records.map(projectAdminBandish),
    });
    return true;
  }

  if (method === 'POST' && pathname === ADMIN_BANDISH_PATH) {
    const payload = await readPlaintextJson(request);
    const result = await createAdminBandish(store, payload, httpError);
    sendJson(response, 200, {
      ok: true,
      created: result.created,
      record: projectAdminBandish(result.record),
    });
    return true;
  }

  if (isAdminPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

async function adminBandishRecords(store, searchParams) {
  const type = optionalString(searchParams?.get?.('type'));
  const includeRetired = searchParams?.get?.('all') === 'true';
  const limit = limitParam(searchParams, 'limit', DEFAULT_ADMIN_BANDISH_LIMIT, MAX_ADMIN_BANDISH_LIMIT);
  const records = await store.listRecords('AdminBandish');

  return records
    .filter((record) => includeRetired || isLiveRecord(record))
    .filter((record) => !type || record.type === type)
    .sort(compareAdminBandishPriority)
    .slice(0, limit);
}

async function createAdminBandish(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_admin_bandish_payload');
  rejectClientPathFields(payload, httpError);

  try {
    return await store.writeAdminBandish({
      ...payload,
      provenance: payload.provenance ?? { surface: 'admin', lane: 'deliberate' },
    }, { withWriteResult: true });
  } catch {
    throw httpError(400, 'invalid_admin_bandish');
  }
}

export function compareAdminBandishPriority(a, b) {
  return (
    compareIso(a?.remindAt, b?.remindAt) ||
    compareIso(a?.dueAt, b?.dueAt) ||
    effortRank(a?.effort) - effortRank(b?.effort) ||
    String(a?.title ?? '').localeCompare(String(b?.title ?? '')) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

function projectAdminBandish(record) {
  return stripUndefined({
    id: record.id,
    kind: record.kind,
    type: record.type,
    effort: record.effort,
    title: record.title,
    note: record.note,
    remindAt: record.remindAt,
    dueAt: record.dueAt,
    sourceId: record.sourceId,
    recurrence: record.recurrence,
    metadata: record.metadata,
    provenance: record.provenance,
    eventAt: record.eventAt,
    ingestedAt: record.ingestedAt,
    validFrom: record.validFrom,
    validTo: record.validTo,
    supersededById: record.supersededById,
  });
}

function compareIso(left, right) {
  return sortableDate(left).localeCompare(sortableDate(right));
}

function sortableDate(value) {
  return optionalString(value) ?? '9999-12-31T23:59:59.999Z';
}

function effortRank(value) {
  return EFFORT_RANK.get(value) ?? Number.MAX_SAFE_INTEGER;
}

function isLiveRecord(record) {
  return isPlainObject(record) && !record.validTo && !record.supersededById;
}

function limitParam(searchParams, name, fallback, max) {
  const raw = searchParams?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), max);
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'adminPath']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}
