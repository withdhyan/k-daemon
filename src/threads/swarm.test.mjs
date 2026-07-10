import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  createScopedWriter,
  runThreadSwarm,
} from './swarm.mjs';

const fixedNow = () => new Date('2026-06-28T04:05:06.000Z');

test('scoped writer refuses writes outside data/threads/<threadId>/<role>', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-swarm-scope-'));
  const writer = createScopedWriter({
    dataDir,
    threadId: 'thread_scope',
    role: 'explorer',
  });

  await writer.writeJson('ok.json', { kind: 'ThreadScopeTest', ok: true });
  assert.equal(
    await exists(path.join(dataDir, 'threads', 'thread_scope', 'explorer', 'ok.json')),
    true,
  );
  await assert.rejects(
    writer.writeJson('ok.json', { kind: 'ThreadScopeTest', ok: false }),
    /refused to overwrite scoped data path: ok\.json/,
  );

  await assert.rejects(
    writer.writeJson('../worker/escape.json', { kind: 'Escape' }),
    /refused unsafe data path/,
  );
  await assert.rejects(
    writer.writeUniqueJson('../worker', 'escape', { kind: 'Escape' }),
    /refused unsafe data path/,
  );
  assert.throws(
    () => createScopedWriter({
      dataDir,
      threadId: 'thread\0evil',
      role: 'explorer',
    }),
    /unsafe path segment/,
  );
});

test('parallel swarm dispatch is deterministic with serial dispatch under fake dependencies', async () => {
  const parallel = await runFixtureSwarm('parallel');
  const serial = await runFixtureSwarm('serial');

  assert.deepEqual(parallel.result, serial.result);
  assert.deepEqual(
    await jsonSnapshot(path.join(parallel.dataDir, 'threads')),
    await jsonSnapshot(path.join(serial.dataDir, 'threads')),
  );

  const workerDecisions = await dataFiles(
    parallel.dataDir,
    path.join('threads', parallel.thread.threadId, 'worker', 'decisions'),
  );
  assert.equal(workerDecisions.length, 1);
  assert.equal(workerDecisions[0].kind, 'LoopRecommendation');
  assert.equal(workerDecisions[0].advisoryOnly, true);
  assert.equal(workerDecisions[0].acted, 'pending');
  assert.notEqual(workerDecisions[0].tag, '[auto]');
  assert(!Object.hasOwn(workerDecisions[0], 'act'));
  assert(!Object.hasOwn(workerDecisions[0], 'autoAct'));
});

test('swarm role rejection is captured while other roles complete', async () => {
  const { dataDir, store, thread, context } = await seededSwarmStore();

  const result = await runThreadSwarm(thread, context, {
    dataDir,
    store,
    now: fixedNow,
    research: fakeResearch,
    modelCall: async (request) => {
      if (request.station === 'decide') throw new Error('injected worker failure');
      return fakeModelCall(request);
    },
  });

  assert.equal(result.roles.explorer.role, 'explorer');
  assert.equal(result.roles.worker.role, 'worker');
  assert.equal(result.roles.worker.error.message, 'injected worker failure');
  assert.deepEqual(result.roles.worker.mutations, []);
  assert.equal(result.roles.verifier.output.verdict, 'silence');
});

async function runFixtureSwarm(dispatch) {
  const { dataDir, store, thread, context } = await seededSwarmStore();
  const result = await runThreadSwarm(thread, context, {
    dataDir,
    store,
    now: fixedNow,
    modelCall: fakeModelCall,
    research: fakeResearch,
    dispatch,
  });

  return { dataDir, result, thread };
}

async function seededSwarmStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-swarm-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const exposure = await store.writeExposure({
    type: 'observation',
    statement: 'Alpha swarm marker belongs only to this disposable worker.',
    sourceId: 'swarm-alpha',
    eventAt: '2026-06-28T04:00:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });
  const thread = {
    threadId: 'thread_alpha',
    theme: 'Alpha Swarm',
    exposureIds: [exposure.id],
  };
  const context = [
    '## Recent exposure',
    `<<< Exposure:${exposure.id} >>>`,
    JSON.stringify(exposure),
  ].join('\n');

  return { dataDir, store, thread, context };
}

async function fakeResearch(query) {
  return exposureIdsFromText(query).map((id) => ({
    evidenceId: id,
    evidenceIds: [id],
    evidenceGrade: 'L4',
    source: 'fake-research',
    relevanceScore: 0.99,
    noveltySatisfied: true,
    kind: 'Exposure',
    content: `evidence for ${id}`,
  }));
}

async function fakeModelCall(request) {
  const evidenceIds = exposureIdsFromText(request.user);
  if (request.station === 'decide') {
    return {
      summary: 'Stage one advisory recommendation.',
      verdict: 'recommend',
      recommendation: {
        decision: 'Whether this thread should surface an advisory.',
        recommended: 'Review the alpha thread locally.',
        reason: 'The thread contains a reversible local review.',
        reversibility: 'internal-revertible',
        undo: 'Drop the advisory note.',
        evidenceIds,
        confidence: 0.62,
        tag: '[auto]',
      },
    };
  }

  if (request.station === 'verify') {
    return {
      summary: 'Verify advisory-only state.',
      verdict: 'silence',
      verifyNote: {
        reviews: [],
        note: 'No external action was taken.',
      },
    };
  }

  throw new Error(`unexpected station: ${request.station}`);
}

function exposureIdsFromText(text) {
  return [...new Set(String(text).match(/exp_[a-f0-9]{24}/g) ?? [])];
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function dataFiles(dataDir, dirname) {
  const dir = path.join(dataDir, dirname);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))),
  );
}

async function jsonSnapshot(root) {
  const files = [];
  await walkJson(root, '', files);
  return Promise.all(
    files.sort().map(async (relPath) => ({
      path: relPath,
      data: JSON.parse(await fs.readFile(path.join(root, relPath), 'utf8')),
    })),
  );
}

async function walkJson(root, relDir, files) {
  const dir = path.join(root, relDir);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      await walkJson(root, relPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(relPath);
    }
  }
}
