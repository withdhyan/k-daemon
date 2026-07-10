import {
  createRoutineStore,
  parseSchedule,
} from '../../src/agent/routines.mjs';
import {
  isPlainObject,
  optionalString,
} from '../../src/substrate.mjs';

export const ROUTINES_PATH = '/api/routines';
export const ROUTINES_TOGGLE_PATH = '/api/routines/toggle';

export function isRoutinesPath(pathname) {
  return pathname === ROUTINES_PATH || pathname === ROUTINES_TOGGLE_PATH;
}

// Returns true if it handled the request. deps supplies { sendJson, httpError,
// readPlaintextJson, isSameMachine } so this module reuses server-owned helpers.
export async function handleRoutinesRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.routineStore ??
    createRoutineStore({ dataDir: context.dataDir, now: context.now });

  if (method === 'GET' && pathname === ROUTINES_PATH) {
    const routines = await store.listRoutines();
    sendJson(response, 200, { routines: routines.map(projectRoutine) });
    return true;
  }

  if (method === 'POST' && pathname === ROUTINES_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const routine = await createRoutine(store, payload, httpError);
    sendJson(response, 200, { ok: true, routine: projectRoutine(routine) });
    return true;
  }

  if (method === 'POST' && pathname === ROUTINES_TOGGLE_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const routine = await toggleRoutine(store, payload, httpError);
    sendJson(response, 200, { ok: true, routine: projectRoutine(routine) });
    return true;
  }

  if (isRoutinesPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

async function createRoutine(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_routine_payload');
  rejectClientPathFields(payload, httpError);

  const name = optionalString(payload.name);
  if (!name) throw httpError(400, 'missing_name');
  const prompt = optionalString(payload.prompt);
  if (!prompt) throw httpError(400, 'missing_prompt');
  const schedule = optionalString(payload.schedule);
  if (!schedule) throw httpError(400, 'missing_schedule');

  try {
    parseSchedule(schedule);
  } catch {
    throw httpError(400, 'invalid_schedule');
  }

  try {
    return await store.createRoutine({
      id: optionalString(payload.id),
      name,
      prompt,
      schedule,
      enabled: false,
    });
  } catch {
    throw httpError(400, 'invalid_routine');
  }
}

async function toggleRoutine(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_toggle_payload');
  rejectClientPathFields(payload, httpError);

  const id = optionalString(payload.id);
  if (!id) throw httpError(400, 'missing_id');
  if (typeof payload.enabled !== 'boolean') throw httpError(400, 'invalid_enabled');

  let routine;
  try {
    routine = await store.toggleRoutine(id, payload.enabled);
  } catch {
    throw httpError(400, 'invalid_routine');
  }
  if (!routine) throw httpError(404, 'routine_not_found');
  return routine;
}

function assertSameMachine(request, deps, httpError) {
  if (typeof deps.isSameMachine === 'function' && deps.isSameMachine(request) === true) return;
  throw httpError(403, 'loopback_required');
}

function projectRoutine(routine) {
  return {
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    schedule: routine.schedule,
    enabled: routine.enabled,
    lastRunAt: routine.lastRunAt,
    nextRunAt: routine.nextRunAt,
    lastStatus: routine.lastStatus,
    deliver: routine.deliver,
    runner: routine.runner,
    sense: routine.sense,
  };
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'routinePath']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}
