import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  ROUTINES_PATH,
  ROUTINES_TOGGLE_PATH,
  handleRoutinesRoute,
} from '../../daemon/routes/routines.mjs';
import { agentToolRegistry } from './tools.mjs';
import {
  createRoutineStore,
  dueRoutines,
  isRoutineDue,
  nextRunAt,
  parseSchedule,
  tick,
} from './routines.mjs';

const fixedNow = () => new Date('2026-07-02T10:00:00.000Z');

test('createRoutineStore seeds native routines incl. self-syncing senses', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });

  const routines = await store.listRoutines();
  assert.deepEqual(routines.map((routine) => routine.id), [
    'tws-compute',
    'body-loop',
    'whoop-sync',
    'cadence-now-next',
    'dreaming-v1',
    'review-morning-orientation',
    'review-evening-reflection',
    'review-weekly-value-probes',
    'review-weekly-retro',
    'ingest-hermes',
    'research-scan',
    'ingest-apple-notes',
    'ingest-holon-notes',
    'ingest-mind-content',
    'ingest-contextdump',
    'index-exposures',
  ]);
  assert.equal(routines.find((routine) => routine.id === 'index-exposures').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'body-loop').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'whoop-sync').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'cadence-now-next').enabled, true);
  // Ingest senses stay disabled — consent-first; the founder toggles each on.
  assert.equal(routines.find((routine) => routine.id === 'dreaming-v1').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'review-morning-orientation').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'review-evening-reflection').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'review-weekly-value-probes').enabled, true);
  assert.equal(routines.find((routine) => routine.id === 'review-weekly-retro').enabled, true);
  assert(routines
    .filter((routine) => ![
      'index-exposures',
      'body-loop',
      'whoop-sync',
      'cadence-now-next',
      'dreaming-v1',
      'review-morning-orientation',
      'review-evening-reflection',
      'review-weekly-value-probes',
      'review-weekly-retro',
    ].includes(routine.id))
    .every((routine) => routine.enabled === false));
  assert(routines.every((routine) => routine.deliver === 'store'));
  assert.equal(routines.find((routine) => routine.id === 'tws-compute').runner, 'tws');
  assert.equal(routines.find((routine) => routine.id === 'body-loop').runner, 'body-loop');
  assert.equal(routines.find((routine) => routine.id === 'whoop-sync').runner, 'whoop-sync');
  assert.equal(routines.find((routine) => routine.id === 'cadence-now-next').runner, 'cadence');
  assert.equal(routines.find((routine) => routine.id === 'dreaming-v1').runner, 'dreaming');
  assert.equal(
    routines.find((routine) => routine.id === 'review-morning-orientation').runner,
    'review-morning-orientation',
  );
  assert.equal(
    routines.find((routine) => routine.id === 'review-evening-reflection').runner,
    'review-evening-reflection',
  );
  assert.equal(
    routines.find((routine) => routine.id === 'review-weekly-retro').runner,
    'review-weekly-retro',
  );
  assert.equal(
    routines.find((routine) => routine.id === 'review-weekly-value-probes').runner,
    'review-weekly-value-probes',
  );
  assert.equal(routines.find((routine) => routine.id === 'index-exposures').runner, 'index-exposures');
  assert.doesNotMatch(routines.find((routine) => routine.id === 'tws-compute').prompt, /Placeholder/);
  // Sense routines carry the native ingest runner + a sense id.
  const appleNotes = routines.find((routine) => routine.id === 'ingest-apple-notes');
  assert.equal(appleNotes.runner, 'ingest');
  assert.equal(appleNotes.sense, 'apple-notes');
});

test('schedule parsing supports every-N intervals and cron edges', () => {
  assert.deepEqual(pickInterval(parseSchedule('every 15m')), {
    kind: 'interval',
    count: 15,
    unit: 'm',
  });
  assert.equal(
    nextRunAt('every 2h', '2026-07-02T10:30:00.000Z'),
    '2026-07-02T12:30:00.000Z',
  );

  const sunday = parseSchedule('0 0 * * 7');
  assert.equal(sunday.kind, 'cron');
  assert.deepEqual(sunday.dayOfWeek.values, [0]);
  assert.equal(
    nextRunAt('0 0 * * 7', '2026-07-04T23:59:00.000Z'),
    '2026-07-05T00:00:00.000Z',
  );
  assert.equal(
    nextRunAt('*/15 9-10 * * 1-5', '2026-07-06T09:14:30.000Z'),
    '2026-07-06T09:15:00.000Z',
  );

  for (const schedule of ['every 0m', 'every 5w', '* * * *', '60 * * * *', '*/0 * * * *']) {
    assert.throws(() => parseSchedule(schedule), /invalid|out of range/);
  }
});

test('due computation returns enabled routines whose nextRunAt is due', () => {
  const now = '2026-07-02T10:00:00.000Z';
  const due = routine({ id: 'due', enabled: true, nextRunAt: '2026-07-02T09:59:00.000Z' });
  const future = routine({ id: 'future', enabled: true, nextRunAt: '2026-07-02T10:01:00.000Z' });
  const disabled = routine({ id: 'disabled', enabled: false, nextRunAt: '2026-07-02T09:00:00.000Z' });

  assert.equal(isRoutineDue(due, now), true);
  assert.equal(isRoutineDue(future, now), false);
  assert.equal(isRoutineDue(disabled, now), false);
  assert.deepEqual(dueRoutines([future, disabled, due], now).map((entry) => entry.id), ['due']);
});

test('tick runs due-only, updates run fields, and archives markdown output', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({ id: 'due-routine', prompt: 'run due', enabled: true, nextRunAt: '2026-07-02T09:59:00.000Z' }),
    routine({ id: 'future-routine', prompt: 'future', enabled: true, nextRunAt: '2026-07-02T10:01:00.000Z' }),
    routine({ id: 'disabled-routine', prompt: 'disabled', enabled: false, nextRunAt: '2026-07-02T09:00:00.000Z' }),
  ]);

  const calls = [];
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async (input) => {
      calls.push(input);
      return { content: 'routine output' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.locked, false);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['due-routine']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userMessage, 'run due');
  assert.equal(calls[0].tools, false);
  assert(calls[0].toolGrants instanceof Set);
  assert.equal(calls[0].toolGrants.size, 0);

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /# Routine: due-routine/);
  assert.match(output, /routine output/);

  const routines = await store.listRoutines();
  const due = routines.find((entry) => entry.id === 'due-routine');
  const future = routines.find((entry) => entry.id === 'future-routine');
  const disabled = routines.find((entry) => entry.id === 'disabled-routine');
  assert.equal(due.lastRunAt, '2026-07-02T10:00:00.000Z');
  assert.equal(due.nextRunAt, '2026-07-02T10:05:00.000Z');
  assert.equal(due.lastStatus, 'ok');
  assert.equal(future.lastRunAt, null);
  assert.equal(disabled.lastRunAt, null);

  const heartbeat = JSON.parse(
    await fs.readFile(path.join(dataDir, 'routines', '.tick.heartbeat.json'), 'utf8'),
  );
  assert.equal(heartbeat.status, 'idle');
  assert.equal(heartbeat.ranCount, 1);
});

test('tws native routine runner computes TWS and archives without runTurn', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await writeDecision(dataDir, '2026-07-02T09-00-00.json', {
    acted: 'acted',
    recommended: 'Review the captured decision.',
  });
  await writeDecision(dataDir, '2026-07-02T09-01-00.json', {
    tag: '[advise]',
    surface: 'body',
    targetSurface: 'body',
    recommendationKind: 'body-protocol',
    recommended: 'Review the deliberation recommendation later.',
  });
  await store.replaceRoutines([
    routine({
      id: 'tws-compute',
      runner: 'tws',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native TWS runner must not fall back to runTurn');
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['tws-compute']);
  assert.equal(runTurnCalls, 0);

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /# Routine: tws-compute/);
  assert.match(output, /score: 0\.5/);
  assert.match(output, /recommended: 2/);
  assert.match(output, /bodyRecommended: 1/);
  assert.match(output, /bodyScore: 0/);
  assert.match(output, /measures only captured decisions; blind to uncaptured life/);
});

test('body-loop native routine runner stages protocols without runTurn', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'body-loop',
      runner: 'body-loop',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const bodyLoopCalls = [];
  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native body-loop runner must not fall back to runTurn');
    },
    bodyLoop: async (options) => {
      bodyLoopCalls.push(options);
      return {
        kind: 'HealthColdLoopResult',
        schemaVersion: 1,
        signalStatus: 'actionable',
        signalReason: 'low-sleep',
        genomicTraitCount: 1,
        footprintCount: 2,
        recentFootprintCount: 2,
        protocolCount: 1,
        stagedCount: 1,
        refusedCount: 0,
        protocols: [],
        refusedProtocols: [],
        mutations: [{ op: 'write', path: 'data/decisions/body.json', kind: 'LoopRecommendation' }],
        notes: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['body-loop']);
  assert.equal(runTurnCalls, 0);
  assert.equal(bodyLoopCalls.length, 1);
  assert.equal(bodyLoopCalls[0].dataDir, dataDir);
  assert.equal(bodyLoopCalls[0].now().toISOString(), fixedNow().toISOString());

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /## Body cold loop/);
  assert.match(output, /signal: actionable/);
  assert.match(output, /staged: 1/);
});

test('whoop-sync native routine runner archives API backoff without runTurn failure', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'whoop-sync',
      runner: 'whoop-sync',
      schedule: 'every 30m',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const whoopCalls = [];
  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native WHOOP runner must not fall back to runTurn');
    },
    whoopSync: async (options) => {
      whoopCalls.push(options);
      return {
        skipped: true,
        reason: 'api_failure',
        message: 'WHOOP request failed (503)',
        backoff: true,
        createdCount: 0,
        duplicateCount: 0,
        counts: { recovery: 0, sleep: 0, cycle: 0, workout: 0 },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['whoop-sync']);
  assert.equal(result.ran[0].ok, true);
  assert.equal(runTurnCalls, 0);
  assert.equal(whoopCalls.length, 1);
  assert.equal(whoopCalls[0].dataDir, dataDir);
  assert.equal(whoopCalls[0].now().toISOString(), fixedNow().toISOString());

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /## WHOOP sync/);
  assert.match(output, /status: skipped/);
  assert.match(output, /reason: api_failure/);
  assert.match(output, /backoff: true/);

  const recorded = (await store.listRoutines()).find((entry) => entry.id === 'whoop-sync');
  assert.equal(recorded.lastStatus, 'ok');
});

test('cadence native routine runner recomputes now-next without runTurn', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'cadence-now-next',
      runner: 'cadence',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const cadenceCalls = [];
  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native cadence runner must not fall back to runTurn');
    },
    cadenceEngine: async (options) => {
      cadenceCalls.push(options);
      return {
        ok: true,
        date: '2026-07-02',
        daySource: 'default-template',
        trigger: options.trigger,
        nowBlock: { id: 'deep-0900-2026-07-02' },
        nextBlock: { id: 'breakthrough-1130-2026-07-02' },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['cadence-now-next']);
  assert.equal(runTurnCalls, 0);
  assert.equal(cadenceCalls.length, 1);
  assert.equal(cadenceCalls[0].dataDir, dataDir);
  assert.equal(cadenceCalls[0].now().toISOString(), fixedNow().toISOString());
  assert.deepEqual(cadenceCalls[0].trigger, {
    type: 'tick',
    source: 'routine',
    eventId: 'cadence-now-next',
  });

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /## Cadence now\/next/);
  assert.match(output, /source: default-template/);
  assert.match(output, /now: deep-0900-2026-07-02/);
});

test('dreaming native routine runner emits edge report without runTurn', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'dreaming-v1',
      runner: 'dreaming',
      schedule: '0 3 * * *',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const dreamingCalls = [];
  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native dreaming runner must not fall back to runTurn');
    },
    dreaming: async (options) => {
      dreamingCalls.push(options);
      return {
        kind: 'DreamingResult',
        schemaVersion: 1,
        runId: 'dream-test',
        atomCount: 5,
        attractorCount: 2,
        remLinkCount: 1,
        candidateCount: 1,
        emittedCount: 1,
        edgeCards: [{ edgeKey: 'dream-edge-test' }],
        hitRate: {
          hitRate: null,
          junkRate: null,
        },
        runPath: 'dreaming/runs/dream-test.json',
        mutations: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['dreaming-v1']);
  assert.equal(runTurnCalls, 0);
  assert.equal(dreamingCalls.length, 1);
  assert.equal(dreamingCalls[0].dataDir, dataDir);
  assert.equal(dreamingCalls[0].now().toISOString(), fixedNow().toISOString());

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /## Dreaming/);
  assert.match(output, /atoms: 5/);
  assert.match(output, /edgeCards: 1/);
});

test('review cadence native routine runners generate cards without runTurn', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await writeText(path.join(dataDir, 'substrate', 'user-model.md'), [
    '# User model',
    'Preserve richness, recover intent, and validate through lived cadence.',
  ].join('\n'));
  await writeDecision(dataDir, '2026-07-02T09-00-00.json', {
    decision: 'Whether to generate review cadence cards.',
    recommended: 'Generate morning and evening review cards.',
  });
  await writeJson(path.join(dataDir, 'cadence', 'tws', 'block-a.json'), {
    id: 'prompt-block-a',
    kind: 'CadenceTwsPrompt',
    schemaVersion: 1,
    date: '2026-07-02',
    blockId: 'block-a',
    blockTitle: 'Deep work',
    status: 'pending',
    askedAt: '2026-07-02T09:30:00.000Z',
  });
  await writeJson(path.join(dataDir, 'cadence', 'acts', 'act-a.json'), {
    id: 'act-block-a',
    kind: 'CadenceAct',
    blockId: 'block-a',
    action: 'complete',
    wellSpent: true,
    completedAt: '2026-07-02T09:45:00.000Z',
  });
  await store.replaceRoutines([
    routine({
      id: 'review-morning-orientation',
      runner: 'review-morning-orientation',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
    routine({
      id: 'review-evening-reflection',
      runner: 'review-evening-reflection',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
    routine({
      id: 'review-weekly-value-probes',
      runner: 'review-weekly-value-probes',
      schedule: '0 17 * * 0',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
    routine({
      id: 'review-weekly-retro',
      runner: 'review-weekly-retro',
      schedule: '0 18 * * 0',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native review cadence runner must not fall back to runTurn');
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), [
    'review-morning-orientation',
    'review-evening-reflection',
    'review-weekly-value-probes',
    'review-weekly-retro',
  ]);
  assert.equal(runTurnCalls, 0);

  const morningOutput = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  const eveningOutput = await fs.readFile(path.join(dataDir, result.ran[1].outputPath), 'utf8');
  const valueProbeOutput = await fs.readFile(path.join(dataDir, result.ran[2].outputPath), 'utf8');
  const weeklyOutput = await fs.readFile(path.join(dataDir, result.ran[3].outputPath), 'utf8');
  assert.match(morningOutput, /review cadence: morning-orientation/);
  assert.match(morningOutput, /decisions needed: 1/);
  assert.match(eveningOutput, /review cadence: evening-reflection/);
  assert.match(eveningOutput, /tws backfill pending: 1/);
  assert.match(valueProbeOutput, /review cadence: value-probe/);
  assert.match(valueProbeOutput, /probes: [1-3]/);
  assert.match(weeklyOutput, /review cadence: weekly-retro/);
  assert.match(weeklyOutput, /tws prompts: 1\/1 answered/);

  const morningCard = JSON.parse(
    await fs.readFile(
      path.join(dataDir, 'review-cadences', 'cards', 'review-2026-07-02-morning-orientation.json'),
      'utf8',
    ),
  );
  const eveningCard = JSON.parse(
    await fs.readFile(
      path.join(dataDir, 'review-cadences', 'cards', 'review-2026-07-02-evening-reflection.json'),
      'utf8',
    ),
  );
  const weeklyCard = JSON.parse(
    await fs.readFile(
      path.join(dataDir, 'review-cadences', 'cards', 'review-2026-07-02-weekly-retro.json'),
      'utf8',
    ),
  );
  const valueProbeCard = JSON.parse(
    await fs.readFile(
      path.join(dataDir, 'review-cadences', 'cards', 'review-2026-07-02-value-probe.json'),
      'utf8',
    ),
  );
  assert.equal(morningCard.sections.decisionsNeeded.length, 1);
  assert.equal(eveningCard.twsBackfill.pendingCount, 1);
  assert.equal(valueProbeCard.type, 'value-probe');
  assert(valueProbeCard.valueProbes.probes.length <= 3);
  assert.equal(valueProbeCard.valueProbes.probes[0].forcedChoice, true);
  assert.equal(weeklyCard.type, 'weekly-retro');
  assert.equal(weeklyCard.retro.evalHealth.tws.promptCount, 1);
  assert.deepEqual(weeklyCard.retro.goals, []);
  assert.deepEqual(weeklyCard.retro.lists, []);
});

test('ingest native runner drives the registered sense and archives its result', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'ingest-apple-notes',
      runner: 'ingest',
      sense: 'apple-notes',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const senseCalls = [];
  let runTurnCalls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      runTurnCalls += 1;
      throw new Error('native ingest runner must not fall back to runTurn');
    },
    senses: {
      'apple-notes': async (context) => {
        senseCalls.push(context);
        return { skipped: false, createdCount: 2, duplicateCount: 1 };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran.map((entry) => entry.id), ['ingest-apple-notes']);
  assert.equal(runTurnCalls, 0);
  assert.equal(senseCalls.length, 1);
  assert.equal(typeof senseCalls[0].store, 'object');

  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /## Sense: apple-notes/);
  assert.match(output, /status: ok/);
  assert.match(output, /new: 2/);
  assert.match(output, /duplicate: 1/);

  const recorded = (await store.listRoutines()).find((entry) => entry.id === 'ingest-apple-notes');
  assert.equal(recorded.lastStatus, 'ok');
});

test('ingest runner treats an access-gated skip as a normal (non-error) outcome', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'ingest-apple-notes',
      runner: 'ingest',
      sense: 'apple-notes',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => { throw new Error('unused'); },
    senses: {
      'apple-notes': async () => ({
        skipped: true,
        reason: 'permission-denied',
        message: 'grant Full Disk Access and re-run',
      }),
    },
  });

  assert.deepEqual(result.ran, [{ id: 'ingest-apple-notes', ok: true, outputPath: result.ran[0].outputPath }]);
  const output = await fs.readFile(path.join(dataDir, result.ran[0].outputPath), 'utf8');
  assert.match(output, /status: skipped/);
  assert.match(output, /reason: permission-denied/);

  const recorded = (await store.listRoutines()).find((entry) => entry.id === 'ingest-apple-notes');
  assert.equal(recorded.lastStatus, 'ok');
});

test('ingest runner records an error when no sense is registered', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({
      id: 'ingest-apple-notes',
      runner: 'ingest',
      sense: 'apple-notes',
      enabled: true,
      nextRunAt: '2026-07-02T09:59:00.000Z',
    }),
  ]);

  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => { throw new Error('unused'); },
    senses: {},
  });

  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].ok, false);
  assert.match(result.ran[0].error, /no sense registered/);

  const recorded = (await store.listRoutines()).find((entry) => entry.id === 'ingest-apple-notes');
  assert.equal(recorded.lastStatus, 'error');
});

test('tick lock prevents overlapping routine runs', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({ id: 'due-routine', enabled: true, nextRunAt: '2026-07-02T09:59:00.000Z' }),
  ]);
  await fs.writeFile(
    path.join(dataDir, 'routines', '.tick.lock'),
    `${JSON.stringify({ acquiredAt: '2026-07-02T09:59:30.000Z', token: 'held' })}\n`,
    'utf8',
  );

  let calls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      calls += 1;
      return { content: 'must not run' };
    },
  });

  assert.equal(result.locked, true);
  assert.equal(calls, 0);
  const routines = await store.listRoutines();
  assert.equal(routines.find((entry) => entry.id === 'due-routine').lastRunAt, null);
});

test('disabled routines are skipped even when nextRunAt is in the past', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({ id: 'disabled-routine', enabled: false, nextRunAt: '2026-07-02T09:00:00.000Z' }),
  ]);

  let calls = 0;
  const result = await tick({
    store,
    now: fixedNow(),
    runTurn: async () => {
      calls += 1;
      return { content: 'nope' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ran, []);
  assert.equal(calls, 0);
});

test('routines route validates create and toggle, with same-machine mutations only', async () => {
  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });

  const remoteCreate = await dispatchRoute({
    dataDir,
    store,
    sameMachine: false,
    method: 'POST',
    pathname: ROUTINES_PATH,
    payload: { name: 'Remote', prompt: 'x', schedule: 'every 5m' },
  });
  assert.equal(remoteCreate.status, 403);
  assert.deepEqual(remoteCreate.body, { ok: false, error: 'loopback_required' });

  const invalidSchedule = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: ROUTINES_PATH,
    payload: { name: 'Bad', prompt: 'x', schedule: 'every 0m' },
  });
  assert.equal(invalidSchedule.status, 400);
  assert.deepEqual(invalidSchedule.body, { ok: false, error: 'invalid_schedule' });

  const created = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: ROUTINES_PATH,
    payload: { name: 'Morning scan', prompt: 'scan', schedule: 'every 30m', enabled: true },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.routine.name, 'Morning scan');
  assert.equal(created.body.routine.enabled, false);

  const invalidToggle = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: ROUTINES_TOGGLE_PATH,
    payload: { id: created.body.routine.id, enabled: 'true' },
  });
  assert.equal(invalidToggle.status, 400);
  assert.deepEqual(invalidToggle.body, { ok: false, error: 'invalid_enabled' });

  const toggled = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: ROUTINES_TOGGLE_PATH,
    payload: { id: created.body.routine.id, enabled: true },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.routine.enabled, true);

  const listed = await dispatchRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: ROUTINES_PATH,
  });
  assert.equal(listed.status, 200);
  assert(listed.body.routines.some((entry) => entry.id === created.body.routine.id));
});

test('routine turns cannot self-schedule because no create-routine tool is exposed', async () => {
  const createToolIds = new Set(['routine.create', 'routines.create', 'schedule.create']);
  assert.equal(agentToolRegistry().some((tool) => createToolIds.has(tool.id)), false);

  const dataDir = await tempDataDir();
  const store = createRoutineStore({ dataDir, now: fixedNow });
  await store.replaceRoutines([
    routine({ id: 'due-routine', enabled: true, nextRunAt: '2026-07-02T09:59:00.000Z' }),
  ]);

  let captured;
  await tick({
    store,
    now: fixedNow(),
    runTurn: async (input) => {
      captured = input;
      return { content: 'ok' };
    },
  });

  assert.equal(captured.tools, false);
  assert.deepEqual([...captured.toolGrants], []);
});

function pickInterval(schedule) {
  return {
    kind: schedule.kind,
    count: schedule.count,
    unit: schedule.unit,
  };
}

function routine(overrides = {}) {
  const id = overrides.id ?? 'routine';
  return {
    id,
    name: overrides.name ?? id,
    prompt: overrides.prompt ?? 'prompt',
    schedule: overrides.schedule ?? 'every 5m',
    enabled: overrides.enabled ?? false,
    lastRunAt: overrides.lastRunAt ?? null,
    nextRunAt: overrides.nextRunAt ?? '2026-07-02T10:05:00.000Z',
    lastStatus: overrides.lastStatus ?? null,
    deliver: 'store',
    ...(overrides.runner ? { runner: overrides.runner } : {}),
    ...(overrides.sense ? { sense: overrides.sense } : {}),
  };
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-routines-'));
}

async function writeDecision(dataDir, name, overrides = {}) {
  await writeJson(path.join(dataDir, 'decisions', name), {
      kind: 'LoopRecommendation',
      schemaVersion: 1,
      station: 'decide',
      date: '2026-07-02',
      verdict: 'recommend',
      acted: 'pending',
      advisoryOnly: true,
      decision: 'Whether to count this recommendation.',
      recommended: 'Review the recommendation.',
      reason: 'It is captured.',
      reversibility: 'internal-revertible',
      undo: 'Leave it pending.',
      evidenceIds: [],
      confidence: 0.5,
      summary: 'Captured recommendation.',
      createdAt: '2026-07-02T09:00:00.000Z',
      ...overrides,
  });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${value}\n`, 'utf8');
}

async function dispatchRoute(input) {
  const response = mockResponse();
  const deps = routeDeps(input.sameMachine !== false);
  try {
    await handleRoutinesRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: input.pathname,
        dataDir: input.dataDir,
        now: fixedNow,
        routineStore: input.store,
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
  }
  return {
    status: response.statusCode,
    body: JSON.parse(response.body),
  };
}

function routeDeps(sameMachine) {
  return {
    sendJson(response, statusCode, body) {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(body)}\n`);
    },
    httpError(statusCode, code) {
      const error = new Error(code);
      error.statusCode = statusCode;
      error.code = code;
      error.expose = true;
      return error;
    },
    readPlaintextJson: async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
    isSameMachine: () => sameMachine,
  };
}

function mockRequest(payload) {
  if (payload === undefined) return Readable.from([]);
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}
