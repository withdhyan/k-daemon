import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import { backfillExposureIndex } from './exposure-index.mjs';
import { computeTwsFromDataDir } from '../eval/tws.mjs';
import {
  isPlainObject,
  optionalString,
  requiredString,
} from '../substrate.mjs';

export const ROUTINES_DIR = 'routines';
export const ROUTINES_FILE = 'routines.json';
export const ROUTINE_DELIVER = 'store';
export const TICK_LOCK_STALE_MS = 120_000;

const ROUTINE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SENSE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MINUTE_MS = 60_000;
// Native runners execute code, not an LLM turn. 'ingest' drives a registered
// sense adapter (Apple Notes, X bookmarks, …) so a sense keeps itself current
// on a cadence — the difference between a one-time fetch and a living sense.
const NATIVE_RUNNERS = new Set(['tws', 'ingest', 'index-exposures', 'body-loop', 'whoop-sync', 'cadence', 'dreaming', 'review-morning-orientation', 'review-evening-reflection', 'review-weekly-retro', 'review-weekly-value-probes']);
const UNIT_MS = Object.freeze({
  m: MINUTE_MS,
  h: 60 * MINUTE_MS,
  d: 24 * 60 * MINUTE_MS,
});

const SEED_ROUTINES = Object.freeze([
  Object.freeze({
    id: 'tws-compute',
    name: 'tws-compute',
    prompt:
      'Compute the founder TWS reading from captured LoopRecommendations in data/decisions and archive the structured report, including blindSpots.',
    schedule: 'every 1d',
    runner: 'tws',
  }),
  Object.freeze({
    id: 'body-loop',
    name: 'body-loop',
    prompt:
      'Native body cold loop: compute vital baselines from recent body samples and stage governed advisory protocols when the signal earns it.',
    schedule: 'every 6h',
    runner: 'body-loop',
    enabled: true,
  }),
  Object.freeze({
    id: 'whoop-sync',
    name: 'whoop-sync',
    prompt:
      'Native WHOOP sense: refresh OAuth tokens when needed and sync recovery, sleep, cycle, and workout vitals into the body substrate.',
    schedule: 'every 30m',
    runner: 'whoop-sync',
    enabled: true,
  }),
  Object.freeze({
    id: 'cadence-now-next',
    name: 'cadence-now-next',
    prompt:
      'Native cadence engine: recompute the living now/next snapshot from the drafted day, or the day-zero default template before K has drafted.',
    schedule: 'every 1m',
    runner: 'cadence',
    enabled: true,
  }),
  Object.freeze({
    id: 'dreaming-v1',
    name: 'dreaming-v1',
    prompt:
      'Native dreaming loop: run slow-wave attractor bunching, REM remote-linking, decay, and edge-card emission over live idea atoms.',
    schedule: '0 3 * * *',
    runner: 'dreaming',
    enabled: true,
  }),
  Object.freeze({
    id: 'review-morning-orientation',
    name: 'review-morning-orientation',
    prompt:
      'Native review cadence: generate the morning orientation card with overnight summary, priorities, and decisions-needed.',
    schedule: '0 6 * * *',
    runner: 'review-morning-orientation',
    enabled: true,
  }),
  Object.freeze({
    id: 'review-evening-reflection',
    name: 'review-evening-reflection',
    prompt:
      'Native review cadence: generate the evening reflection card with wins, blockers, tomorrow, overnight queue, energy, and TWS backfill.',
    schedule: '0 21 * * *',
    runner: 'review-evening-reflection',
    enabled: true,
  }),
  Object.freeze({
    id: 'review-weekly-value-probes',
    name: 'review-weekly-value-probes',
    prompt:
      'Native elicitation cadence: generate up to three forced-choice value probes from the user-model and soul document, staged as a value-probe review card.',
    schedule: '0 17 * * 0',
    runner: 'review-weekly-value-probes',
    enabled: true,
  }),
  Object.freeze({
    id: 'review-weekly-retro',
    name: 'review-weekly-retro',
    prompt:
      'Native review cadence: generate the weekly retro card with weekly goals, lists, and eval-health panel.',
    schedule: '0 18 * * 0',
    runner: 'review-weekly-retro',
    enabled: true,
  }),
  Object.freeze({
    id: 'ingest-hermes',
    name: 'ingest-hermes',
    prompt:
      'Routine note: the integration lane should run the existing daemon verb `node daemon/run.mjs ingest-hermes` and summarize staged capability changes. This first slice records the scheduled prompt only.',
    schedule: 'every 1d',
  }),
  Object.freeze({
    id: 'research-scan',
    name: 'research-scan',
    prompt:
      'Placeholder: scan stored open research questions and produce a short markdown brief for founder review. Tools remain disabled in the GA-7 first slice.',
    schedule: 'every 6h',
  }),
  // Self-syncing senses — disabled by default (consent-first). Toggling one on
  // makes that sense re-scan on its cadence; ingestWire dedup keeps it idempotent
  // so only genuinely new exposures land. Each stays silent (skips) until its
  // access is granted (Full Disk Access, a logged-in session, …).
  Object.freeze({
    id: 'ingest-apple-notes',
    name: 'ingest-apple-notes',
    prompt: 'Native sense: re-scan Apple Notes into the substrate.',
    schedule: 'every 6h',
    runner: 'ingest',
    sense: 'apple-notes',
  }),
  Object.freeze({
    id: 'ingest-holon-notes',
    name: 'ingest-holon-notes',
    prompt: 'Native sense: re-scan the notes export directory into the substrate.',
    schedule: 'every 1d',
    runner: 'ingest',
    sense: 'holon-notes',
  }),
  Object.freeze({
    id: 'ingest-mind-content',
    name: 'ingest-mind-content',
    prompt: 'Native sense: re-scan the approved canonical mind-content corpus into the substrate.',
    schedule: 'every 1d',
    runner: 'ingest',
    sense: 'mind-content',
  }),
  Object.freeze({
    id: 'ingest-contextdump',
    name: 'ingest-contextdump',
    prompt: 'Native sense: re-scan the context-dump markdown corpus into the substrate.',
    schedule: 'every 1d',
    runner: 'ingest',
    sense: 'contextdump',
  }),
  Object.freeze({
    id: 'index-exposures',
    name: 'index-exposures',
    prompt: 'Native indexer: embed new live exposures into the local retrieval index.',
    schedule: 'every 6h',
    runner: 'index-exposures',
    enabled: true,
  }),
]);
const BACKFILL_SEED_ROUTINE_IDS = new Set(['body-loop', 'whoop-sync', 'cadence-now-next', 'index-exposures', 'dreaming-v1', 'ingest-mind-content', 'review-morning-orientation', 'review-evening-reflection', 'review-weekly-retro', 'review-weekly-value-probes']);

export function createRoutineStore(options = {}) {
  return new RoutineStore(options);
}

export class RoutineStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = options.now ?? (() => new Date());
    seedRoutinesIfEmpty(this.dataDir, this.now);
  }

  async listRoutines() {
    const doc = await this.#readDoc();
    return doc.routines.map((routine) => ({ ...routine }));
  }

  async createRoutine(input) {
    const doc = await this.#readDoc();
    const routine = normalizeRoutineRecord(input, {
      existingIds: new Set(doc.routines.map((entry) => entry.id)),
      now: this.now(),
      generateId: true,
    });
    doc.routines.push(routine);
    await this.#writeDoc(doc);
    return { ...routine };
  }

  async replaceRoutines(routines) {
    if (!Array.isArray(routines)) throw new Error('routines must be an array');
    const existingIds = new Set();
    const normalized = routines.map((routine) => {
      const record = normalizeRoutineRecord(routine, {
        existingIds,
        now: this.now(),
        generateId: false,
      });
      existingIds.add(record.id);
      return record;
    });
    await this.#writeDoc({ schemaVersion: 1, routines: normalized });
    return normalized.map((routine) => ({ ...routine }));
  }

  async toggleRoutine(id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    const routineId = assertRoutineId(id);
    const doc = await this.#readDoc();
    const index = doc.routines.findIndex((routine) => routine.id === routineId);
    if (index < 0) return null;

    const current = doc.routines[index];
    const now = this.now();
    const nextRunAt =
      enabled && (!current.nextRunAt || new Date(current.nextRunAt).getTime() <= dateFrom(now).getTime())
        ? computeNextRunAt(current.schedule, now)
        : current.nextRunAt;
    const updated = {
      ...current,
      enabled,
      nextRunAt,
    };
    doc.routines[index] = updated;
    await this.#writeDoc(doc);
    return { ...updated };
  }

  async recordRun(id, input) {
    const routineId = assertRoutineId(id);
    const runAt = dateFrom(input?.now ?? this.now());
    const doc = await this.#readDoc();
    const index = doc.routines.findIndex((routine) => routine.id === routineId);
    if (index < 0) return null;

    const current = doc.routines[index];
    const updated = {
      ...current,
      lastRunAt: iso(runAt),
      nextRunAt: computeNextRunAt(current.schedule, runAt),
      lastStatus: optionalString(input?.status) ?? 'ok',
    };
    doc.routines[index] = updated;
    await this.#writeDoc(doc);
    return { ...updated };
  }

  async archiveOutput(routine, now, output) {
    const routineId = assertRoutineId(routine?.id);
    const stamp = fileStamp(now);
    const dirname = path.join(ROUTINES_DIR, 'output', routineId);
    const markdown = renderRoutineOutput(routine, now, output);

    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? '' : `-${index + 1}`;
      const relPath = path.join(dirname, `${stamp}${suffix}.md`);
      const file = safeDataPath(this.dataDir, relPath);
      try {
        await atomicWriteText(file, markdown, { exclusive: true });
        return toDataRelPath(relPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    throw new Error(`could not allocate routine output path: ${routineId}/${stamp}.md`);
  }

  async acquireTickLock(now) {
    const acquiredAt = iso(now);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const file = this.#lockFile();
    await fs.mkdir(path.dirname(file), { recursive: true });

    const tryAcquire = async () => {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ acquiredAt, token, pid: process.pid }, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    };

    try {
      await tryAcquire();
      return lockHandle(file, token);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    if (await this.#lockIsStale(file, now)) {
      await fs.unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      try {
        await tryAcquire();
        return lockHandle(file, token);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    return { acquired: false, release: async () => {} };
  }

  async writeHeartbeat(input = {}) {
    const now = input.now ?? this.now();
    const heartbeat = {
      kind: 'RoutineTickHeartbeat',
      schemaVersion: 1,
      updatedAt: iso(now),
      ...input,
      now: iso(now),
    };
    const file = this.#heartbeatFile();
    await atomicWriteJson(file, heartbeat);
    return heartbeat;
  }

  #rootDir() {
    return safeDataPath(this.dataDir, ROUTINES_DIR);
  }

  #file() {
    return safeDataPath(this.dataDir, path.join(ROUTINES_DIR, ROUTINES_FILE));
  }

  #lockFile() {
    return safeDataPath(this.dataDir, path.join(ROUTINES_DIR, '.tick.lock'));
  }

  #heartbeatFile() {
    return safeDataPath(this.dataDir, path.join(ROUTINES_DIR, '.tick.heartbeat.json'));
  }

  async #readDoc() {
    let text;
    try {
      text = await fs.readFile(this.#file(), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      seedRoutinesIfEmpty(this.dataDir, this.now);
      text = await fs.readFile(this.#file(), 'utf8');
    }

    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.routines)) {
      throw new Error('invalid routines store');
    }
    return {
      schemaVersion: 1,
      routines: parsed.routines.map((routine) =>
        normalizeRoutineRecord(routine, {
          existingIds: new Set(),
          now: this.now(),
          generateId: false,
          trustNextRunAt: true,
        })),
    };
  }

  async #writeDoc(doc) {
    const routines = Array.isArray(doc?.routines) ? doc.routines : [];
    await atomicWriteJson(this.#file(), {
      schemaVersion: 1,
      routines,
    });
  }

  async #lockIsStale(file, now) {
    const nowMs = dateFrom(now).getTime();
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const acquiredAt = optionalString(parsed?.acquiredAt);
      if (acquiredAt) {
        return nowMs - dateFrom(acquiredAt).getTime() > TICK_LOCK_STALE_MS;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return true;
    }

    const stat = await fs.stat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return stat ? nowMs - stat.mtimeMs > TICK_LOCK_STALE_MS : true;
  }
}

export function parseSchedule(value) {
  const source = requiredString(value, 'schedule').replace(/\s+/g, ' ').trim().toLowerCase();
  const every = /^every ([1-9]\d*)\s*([mhd])$/.exec(source);
  if (every) {
    const count = Number(every[1]);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`invalid interval schedule: ${value}`);
    }
    return Object.freeze({
      kind: 'interval',
      source,
      count,
      unit: every[2],
      everyMs: count * UNIT_MS[every[2]],
    });
  }

  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new Error(`invalid schedule: ${value}`);

  return Object.freeze({
    kind: 'cron',
    source,
    minute: parseCronField(parts[0], 0, 59, 'minute'),
    hour: parseCronField(parts[1], 0, 23, 'hour'),
    dayOfMonth: parseCronField(parts[2], 1, 31, 'dayOfMonth'),
    month: parseCronField(parts[3], 1, 12, 'month'),
    dayOfWeek: parseCronField(parts[4], 0, 7, 'dayOfWeek', { normalizeSevenToZero: true }),
  });
}

export function computeNextRunAt(schedule, after) {
  const parsed = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  const base = dateFrom(after);

  if (parsed.kind === 'interval') {
    return iso(new Date(base.getTime() + parsed.everyMs));
  }

  if (parsed.kind !== 'cron') throw new Error('unknown schedule kind');

  const cursor = new Date(base);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = Date.UTC(cursor.getUTCFullYear() + 5, cursor.getUTCMonth(), cursor.getUTCDate(), cursor.getUTCHours(), cursor.getUTCMinutes());

  for (let time = cursor.getTime(); time <= limit; time += MINUTE_MS) {
    const candidate = new Date(time);
    if (cronMatches(parsed, candidate)) return iso(candidate);
  }

  throw new Error(`cron schedule has no next run within five years: ${parsed.source}`);
}

export const nextRunAt = computeNextRunAt;

export function isRoutineDue(routine, now) {
  if (routine?.enabled !== true) return false;
  const next = optionalString(routine.nextRunAt);
  if (!next) return false;
  return dateFrom(next).getTime() <= dateFrom(now).getTime();
}

export function dueRoutines(routines, now) {
  if (!Array.isArray(routines)) return [];
  return routines.filter((routine) => isRoutineDue(routine, now));
}

export async function tick(input = {}) {
  const store = input.store;
  if (!store) throw new Error('store is required');
  if (typeof input.runTurn !== 'function') throw new Error('runTurn is required');

  const now = dateFrom(input.now ?? new Date());
  const lock = await store.acquireTickLock(now);
  if (!lock.acquired) {
    await store.writeHeartbeat({
      now,
      status: 'locked',
      locked: true,
      ranCount: 0,
    });
    return { ok: false, locked: true, ran: [] };
  }

  const ran = [];
  try {
    await store.writeHeartbeat({
      now,
      status: 'running',
      locked: false,
      startedAt: iso(now),
    });

    const routines = await store.listRoutines();
    const due = dueRoutines(routines, now);
    for (const routine of due) {
      try {
        const result = await runRoutineTurn(routine, {
          now,
          runTurn: input.runTurn,
          senses: input.senses,
          store,
          dataDir: input.dataDir ?? store.dataDir,
          substrateStore: input.substrateStore,
          bodyLoop: input.bodyLoop,
          whoopSync: input.whoopSync,
          cadenceEngine: input.cadenceEngine,
          dreaming: input.dreaming,
        });
        const outputPath = await store.archiveOutput(routine, now, result.content);
        await store.recordRun(routine.id, {
          now,
          status: 'ok',
          outputPath,
        });
        ran.push({
          id: routine.id,
          ok: true,
          outputPath,
        });
      } catch (error) {
        await store.recordRun(routine.id, {
          now,
          status: 'error',
        });
        ran.push({
          id: routine.id,
          ok: false,
          error: optionalString(error?.message) ?? 'routine_failed',
        });
      }
    }

    await store.writeHeartbeat({
      now,
      status: 'idle',
      locked: false,
      completedAt: iso(now),
      ranCount: ran.length,
    });

    return { ok: true, locked: false, ran };
  } catch (error) {
    await store.writeHeartbeat({
      now,
      status: 'error',
      locked: false,
      error: optionalString(error?.message) ?? 'routine_tick_failed',
      ranCount: ran.length,
    });
    throw error;
  } finally {
    await lock.release();
  }
}

async function runRoutineTurn(routine, {
  now,
  runTurn,
  senses,
  store,
  dataDir,
  substrateStore,
  bodyLoop,
  whoopSync,
  cadenceEngine,
  dreaming,
}) {
  if (routine.runner === 'tws') {
    const report = await computeTwsFromDataDir({ dataDir, now });
    return {
      content: renderTwsRoutineReport(report),
    };
  }

  if (routine.runner === 'ingest') {
    const sense = senses?.[routine.sense];
    if (typeof sense !== 'function') {
      throw new Error(`no sense registered for ingest routine: ${routine.sense}`);
    }
    // The adapter fails soft (skips) when its access isn't granted; a skip is a
    // normal outcome, not an error — the sense simply stays silent until unlocked.
    const result = await sense({ store, dataDir, now });
    return {
      content: renderIngestRoutineReport(routine, result),
    };
  }

  if (routine.runner === 'index-exposures') {
    const result = await backfillExposureIndex({
      dataDir,
      now,
      store: substrateStore,
    });
    return {
      content: renderExposureIndexRoutineReport(result),
    };
  }

  if (routine.runner === 'body-loop') {
    const bodyLoopImpl = bodyLoop ?? defaultBodyLoop;
    const options = {
      dataDir,
      now: () => now,
    };
    if (substrateStore) options.store = substrateStore;
    const result = await bodyLoopImpl(options);
    return {
      content: renderBodyLoopRoutineReport(result),
    };
  }

  if (routine.runner === 'whoop-sync') {
    const whoopSyncImpl = whoopSync ?? defaultWhoopSync;
    const result = await whoopSyncImpl({
      dataDir,
      now: () => now,
      store: substrateStore,
    });
    return {
      content: renderWhoopSyncRoutineReport(result),
    };
  }

  if (routine.runner === 'cadence') {
    const cadenceEngineImpl = cadenceEngine ?? defaultCadenceEngine;
    const result = await cadenceEngineImpl({
      dataDir,
      now: () => now,
      trigger: {
        type: 'tick',
        source: 'routine',
        eventId: routine.id,
      },
    });
    return {
      content: renderCadenceRoutineReport(result),
    };
  }

  if (routine.runner === 'dreaming') {
    const dreamingImpl = dreaming ?? defaultDreaming;
    const result = await dreamingImpl({
      dataDir,
      now: () => now,
      store: substrateStore,
    });
    return {
      content: renderDreamingRoutineReport(result),
    };
  }

  if (
    routine.runner === 'review-morning-orientation' ||
    routine.runner === 'review-evening-reflection' ||
    routine.runner === 'review-weekly-retro' ||
    routine.runner === 'review-weekly-value-probes'
  ) {
    const {
      REVIEW_CARD_TYPE_EVENING,
      REVIEW_CARD_TYPE_MORNING,
      REVIEW_CARD_TYPE_WEEKLY_RETRO,
      REVIEW_CARD_TYPE_VALUE_PROBE,
      generateReviewCadenceCard,
      renderReviewCadenceRoutineReport,
    } = await import('./review-cadences.mjs');
    const result = await generateReviewCadenceCard({
      dataDir,
      now,
      type: routine.runner === 'review-morning-orientation'
        ? REVIEW_CARD_TYPE_MORNING
        : routine.runner === 'review-evening-reflection'
          ? REVIEW_CARD_TYPE_EVENING
          : routine.runner === 'review-weekly-retro'
            ? REVIEW_CARD_TYPE_WEEKLY_RETRO
            : REVIEW_CARD_TYPE_VALUE_PROBE,
      substrateStore,
    });
    return {
      content: renderReviewCadenceRoutineReport(result),
    };
  }

  const result = await runTurn({
    userMessage: routine.prompt,
    systemPrompt: [
      `Scheduled routine: ${routine.name}`,
      'Return a concise markdown artifact for storage.',
      'GA-7 first slice policy: tools are disabled for scheduled routine turns.',
    ].join('\n'),
    sovereignFloor: true,
    tools: false,
    toolGrants: new Set(),
    routine: {
      id: routine.id,
      name: routine.name,
      schedule: routine.schedule,
      ranAt: iso(now),
      deliver: ROUTINE_DELIVER,
    },
  });

  return {
    content: normalizeTurnOutput(result),
  };
}

async function defaultBodyLoop(options) {
  const { bodyLoop } = await import('../reason/health.mjs');
  return bodyLoop(options);
}

async function defaultWhoopSync(options) {
  const { syncWhoop } = await import('../ingest/whoop.mjs');
  return syncWhoop(options);
}

async function defaultCadenceEngine(options) {
  const { recomputeCadenceNowNext } = await import('./cadence-engine.mjs');
  return recomputeCadenceNowNext(options);
}

async function defaultDreaming(options) {
  const { dream } = await import('../mind/dream.mjs');
  return dream(options);
}

function normalizeRoutineRecord(input, options = {}) {
  if (!isPlainObject(input)) throw new Error('routine must be an object');
  const now = dateFrom(options.now ?? new Date());
  const name = requiredString(input.name, 'routine name');
  const prompt = requiredString(input.prompt, 'routine prompt');
  const schedule = requiredString(input.schedule, 'routine schedule');
  parseSchedule(schedule);
  const runner = normalizeRunner(input.runner);
  const sense = normalizeSense(input.sense, runner);

  const existingIds = options.existingIds ?? new Set();
  const id = options.generateId
    ? routineIdFor(input, existingIds, now)
    : assertRoutineId(input.id);
  if (existingIds.has(id)) throw new Error(`duplicate routine id: ${id}`);

  return {
    id,
    name,
    prompt,
    schedule,
    enabled: input.enabled === true,
    lastRunAt: normalizeIsoOrNull(input.lastRunAt, 'lastRunAt'),
    nextRunAt: options.trustNextRunAt
      ? normalizeIsoOrNull(input.nextRunAt, 'nextRunAt') ?? computeNextRunAt(schedule, now)
      : normalizeIsoOrNull(input.nextRunAt, 'nextRunAt') ?? computeNextRunAt(schedule, now),
    lastStatus: optionalString(input.lastStatus) ?? null,
    deliver: ROUTINE_DELIVER,
    ...(runner ? { runner } : {}),
    ...(sense ? { sense } : {}),
  };
}

function seedRoutinesIfEmpty(dataDir, nowFn) {
  const root = safeDataPath(dataDir, ROUTINES_DIR);
  const file = safeDataPath(dataDir, path.join(ROUTINES_DIR, ROUTINES_FILE));
  mkdirSync(root, { recursive: true });

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.routines) && parsed.routines.length > 0) {
      const now = typeof nowFn === 'function' ? nowFn() : new Date();
      const existingIds = new Set(parsed.routines.map((routine) => routine?.id).filter(Boolean));
      let changed = false;
      for (const seed of SEED_ROUTINES) {
        if (!BACKFILL_SEED_ROUTINE_IDS.has(seed.id)) continue;
        if (existingIds.has(seed.id)) continue;
        parsed.routines.push(normalizeRoutineRecord(seed, {
          existingIds,
          now,
          generateId: false,
        }));
        existingIds.add(seed.id);
        changed = true;
      }
      if (changed) atomicWriteJsonSync(file, { schemaVersion: 1, routines: parsed.routines });
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const now = typeof nowFn === 'function' ? nowFn() : new Date();
  const routines = SEED_ROUTINES.map((routine) =>
    normalizeRoutineRecord(
      {
        ...routine,
        enabled: routine.enabled === true,
      },
      {
        existingIds: new Set(),
        now,
        generateId: false,
      },
    ));
  atomicWriteJsonSync(file, { schemaVersion: 1, routines });
}

function routineIdFor(input, existingIds, now) {
  const explicit = optionalString(input.id);
  if (explicit) return assertRoutineId(explicit);

  const slug = slugify(input.name);
  const hash = createHash('sha256')
    .update(`${input.name}\n${input.prompt}\n${input.schedule}\n${iso(now)}`)
    .digest('hex')
    .slice(0, 8);
  let candidate = `${slug}-${hash}`.slice(0, 80);
  let index = 2;
  while (existingIds.has(candidate)) {
    const suffix = `-${index}`;
    candidate = `${`${slug}-${hash}`.slice(0, 80 - suffix.length)}${suffix}`;
    index += 1;
  }
  return assertRoutineId(candidate);
}

function slugify(value) {
  const slug = requiredString(value, 'routine name')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'routine';
}

function assertRoutineId(value) {
  const id = requiredString(value, 'routine id');
  if (!ROUTINE_ID_PATTERN.test(id)) throw new Error(`invalid routine id: ${id}`);
  return id;
}

function normalizeRunner(value) {
  const runner = optionalString(value);
  if (!runner) return undefined;
  if (!NATIVE_RUNNERS.has(runner)) throw new Error(`unsupported routine runner: ${runner}`);
  return runner;
}

function normalizeSense(value, runner) {
  const sense = optionalString(value);
  if (!sense) {
    if (runner === 'ingest') throw new Error("ingest routine requires a 'sense'");
    return undefined;
  }
  if (runner !== 'ingest') throw new Error("'sense' is only valid for the ingest runner");
  if (!SENSE_ID_PATTERN.test(sense)) throw new Error(`invalid sense id: ${sense}`);
  return sense;
}

function normalizeIsoOrNull(value, field) {
  const text = optionalString(value);
  if (!text) return null;
  try {
    return iso(dateFrom(text));
  } catch {
    throw new Error(`invalid ${field}: ${value}`);
  }
}

function parseCronField(source, min, max, label, options = {}) {
  const raw = requiredString(source, label);
  const values = new Set();
  const pieces = raw.split(',');

  for (const piece of pieces) {
    if (!piece) throw new Error(`invalid cron ${label}: ${source}`);
    const [rangePart, stepPart, extra] = piece.split('/');
    if (extra !== undefined) throw new Error(`invalid cron ${label}: ${source}`);
    const step = stepPart === undefined ? 1 : parsePositiveInt(stepPart, `cron ${label} step`);
    const [start, end] = cronRange(rangePart, min, max, label);
    for (let value = start; value <= end; value += step) {
      values.add(options.normalizeSevenToZero && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) throw new Error(`invalid cron ${label}: ${source}`);
  return Object.freeze({
    source: raw,
    any: raw === '*',
    values: Object.freeze([...values].sort((a, b) => a - b)),
  });
}

function cronRange(source, min, max, label) {
  if (source === '*') return [min, max];
  if (source.includes('-')) {
    const [startRaw, endRaw, extra] = source.split('-');
    if (extra !== undefined) throw new Error(`invalid cron ${label} range: ${source}`);
    const start = parseCronInt(startRaw, min, max, label);
    const end = parseCronInt(endRaw, min, max, label);
    if (end < start) throw new Error(`invalid cron ${label} range: ${source}`);
    return [start, end];
  }
  const value = parseCronInt(source, min, max, label);
  return [value, value];
}

function parseCronInt(value, min, max, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`invalid cron ${label}: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid cron ${label}: ${value}`);
  if (number < min || number > max) throw new Error(`cron ${label} out of range: ${value}`);
  return number;
}

function parsePositiveInt(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`invalid ${label}: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${label}: ${value}`);
  return number;
}

function cronMatches(schedule, date) {
  if (!fieldHas(schedule.minute, date.getUTCMinutes())) return false;
  if (!fieldHas(schedule.hour, date.getUTCHours())) return false;
  if (!fieldHas(schedule.month, date.getUTCMonth() + 1)) return false;

  const dom = fieldHas(schedule.dayOfMonth, date.getUTCDate());
  const dow = fieldHas(schedule.dayOfWeek, date.getUTCDay());
  if (schedule.dayOfMonth.any && schedule.dayOfWeek.any) return true;
  if (schedule.dayOfMonth.any) return dow;
  if (schedule.dayOfWeek.any) return dom;
  return dom || dow;
}

function fieldHas(field, value) {
  return field.values.includes(value);
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function normalizeTurnOutput(result) {
  if (typeof result === 'string') return optionalString(result) ?? '';
  const content = optionalString(result?.content);
  if (content) return content;
  return JSON.stringify(result ?? null, null, 2);
}

function renderTwsRoutineReport(report) {
  const body = report.dimensions?.body ?? {};
  return [
    '## TWS',
    '',
    `score: ${report.score === null ? 'null' : report.score}`,
    `recommended: ${report.counted.recommended}`,
    `acted: ${report.counted.acted}`,
    `silenceCount: ${report.counted.silenceCount}`,
    `bodyRecommended: ${Number(body.recommended ?? 0)}`,
    `bodyActed: ${Number(body.acted ?? 0)}`,
    `bodyScore: ${body.decisionSignal === null || body.decisionSignal === undefined ? 'null' : body.decisionSignal}`,
    '',
    'blindSpots:',
    ...report.blindSpots.map((spot) => `- ${spot.note}`),
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
  ].join('\n');
}

function renderIngestRoutineReport(routine, result) {
  const skipped = result?.skipped === true;
  const lines = [
    `## Sense: ${routine.sense}`,
    '',
    `status: ${skipped ? 'skipped' : 'ok'}`,
  ];
  if (skipped) {
    lines.push(`reason: ${optionalString(result?.reason) ?? 'unavailable'}`);
    const message = optionalString(result?.message);
    if (message) lines.push(`note: ${message}`);
  } else {
    lines.push(
      `new: ${Number(result?.createdCount ?? 0)}`,
      `duplicate: ${Number(result?.duplicateCount ?? 0)}`,
    );
  }
  return lines.join('\n');
}

function renderExposureIndexRoutineReport(result) {
  return [
    '## Exposure retrieval index',
    '',
    `status: ${Number(result?.failedCount ?? 0) > 0 ? 'skipped' : 'ok'}`,
    `indexed: ${Number(result?.indexedCount ?? 0)}`,
    `alreadyIndexed: ${Number(result?.skippedCount ?? 0)}`,
    `failed: ${Number(result?.failedCount ?? 0)}`,
    `capReached: ${result?.capReached === true}`,
    `totalLive: ${Number(result?.totalLive ?? 0)}`,
  ].join('\n');
}

function renderBodyLoopRoutineReport(result) {
  return [
    '## Body cold loop',
    '',
    `signal: ${optionalString(result?.signalStatus) ?? 'unknown'}`,
    `reason: ${optionalString(result?.signalReason) ?? 'none'}`,
    `genomicTraits: ${Number(result?.genomicTraitCount ?? 0)}`,
    `footprints: ${Number(result?.footprintCount ?? 0)}`,
    `recentFootprints: ${Number(result?.recentFootprintCount ?? 0)}`,
    `protocols: ${Number(result?.protocolCount ?? 0)}`,
    `staged: ${Number(result?.stagedCount ?? 0)}`,
    `refused: ${Number(result?.refusedCount ?? 0)}`,
    '',
    '```json',
    JSON.stringify(result ?? null, null, 2),
    '```',
  ].join('\n');
}

function renderWhoopSyncRoutineReport(result) {
  const skipped = result?.skipped === true;
  const lines = [
    '## WHOOP sync',
    '',
    `status: ${skipped ? 'skipped' : 'ok'}`,
  ];
  if (skipped) {
    lines.push(`reason: ${optionalString(result?.reason) ?? 'skipped'}`);
    if (result?.backoff === true) lines.push('backoff: true');
    const message = optionalString(result?.message);
    if (message) lines.push(`note: ${message}`);
  } else {
    lines.push(
      `new: ${Number(result?.createdCount ?? 0)}`,
      `duplicate: ${Number(result?.duplicateCount ?? 0)}`,
      `recovery: ${Number(result?.counts?.recovery ?? 0)}`,
      `sleep: ${Number(result?.counts?.sleep ?? 0)}`,
      `cycle: ${Number(result?.counts?.cycle ?? 0)}`,
      `workout: ${Number(result?.counts?.workout ?? 0)}`,
    );
  }
  lines.push('', '```json', JSON.stringify(result ?? null, null, 2), '```');
  return lines.join('\n');
}

function renderCadenceRoutineReport(result) {
  const skipped = result?.skipped === true;
  const nowBlock = result?.nowBlock;
  const nextBlock = result?.nextBlock;
  const lines = [
    '## Cadence now/next',
    '',
    `status: ${skipped ? 'skipped' : 'ok'}`,
    `date: ${optionalString(result?.date) ?? 'unknown'}`,
    `source: ${optionalString(result?.daySource) ?? 'unknown'}`,
    `trigger: ${optionalString(result?.trigger?.type) ?? 'unknown'}`,
  ];
  if (result?.trigger?.signal) lines.push(`signal: ${result.trigger.signal}`);
  if (result?.caption) lines.push(`caption: ${result.caption}`);
  if (skipped) {
    lines.push(`reason: ${optionalString(result?.reason) ?? 'skipped'}`);
  } else {
    lines.push(
      `now: ${optionalString(nowBlock?.id) ?? 'none'}`,
      `next: ${optionalString(nextBlock?.id) ?? 'none'}`,
    );
  }
  lines.push('', '```json', JSON.stringify(result ?? null, null, 2), '```');
  return lines.join('\n');
}

function renderDreamingRoutineReport(result) {
  const hitRate = result?.hitRate ?? {};
  return [
    '## Dreaming',
    '',
    `atoms: ${Number(result?.atomCount ?? 0)}`,
    `attractors: ${Number(result?.attractorCount ?? 0)}`,
    `remLinks: ${Number(result?.remLinkCount ?? 0)}`,
    `candidates: ${Number(result?.candidateCount ?? 0)}`,
    `edgeCards: ${Number(result?.emittedCount ?? 0)}`,
    `hitRate: ${hitRate.hitRate === null || hitRate.hitRate === undefined ? 'null' : hitRate.hitRate}`,
    `junkRate: ${hitRate.junkRate === null || hitRate.junkRate === undefined ? 'null' : hitRate.junkRate}`,
    '',
    '```json',
    JSON.stringify(result ?? null, null, 2),
    '```',
  ].join('\n');
}

function renderRoutineOutput(routine, now, output) {
  return [
    `# Routine: ${routine.name}`,
    '',
    `- id: ${routine.id}`,
    `- ranAt: ${iso(now)}`,
    `- schedule: ${routine.schedule}`,
    '',
    optionalString(output) ?? '',
    '',
  ].join('\n');
}

export async function atomicWriteJson(file, value) {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(file, text, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temp, text, 'utf8');
    if (options.exclusive) {
      await fs.link(temp, file);
      await fs.unlink(temp);
    } else {
      await fs.rename(temp, file);
    }
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function atomicWriteJsonSync(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

function lockHandle(file, token) {
  return {
    acquired: true,
    release: async () => {
      let current;
      try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (current?.token !== token) return;
      await fs.unlink(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}

function fileStamp(now) {
  return iso(now).replace(/[:.]/g, '-');
}

function toDataRelPath(relPath) {
  return relPath.split(path.sep).join('/');
}
