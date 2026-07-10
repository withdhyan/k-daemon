import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gatherContext } from '../../daemon/run.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { threadContext } from './context.mjs';

const fixedNow = () => new Date('2026-06-28T00:00:00.000Z');

test('gatherContext scopes decide context to explicit thread exposure ids', async () => {
  const { store, dataDir, alpha, beta } = await seededThreadStore();

  const context = await gatherContext('decide', {
    store,
    dataDir,
    threadId: 'thread_alpha',
    threadExposureIds: [alpha.id],
  });
  const resolverContext = await gatherContext('decide', {
    store,
    dataDir,
    threadId: 'thread_alpha',
    threadExposureResolver: async () => [alpha.id],
  });

  assert.equal(resolverContext, context);
  assert.match(context, /^Exposure: 1$/m);
  assert.match(context, /^SelfPattern: 1$/m);
  assert.match(context, /Alpha station context marker/);
  assert.match(context, /Alpha derived self marker/);
  assert.doesNotMatch(context, /Beta station context marker/);
  assert.doesNotMatch(context, /Beta derived self marker/);
  assert.deepEqual(exposureIdsFromContext(context), [alpha.id]);
  assert(!exposureIdsFromContext(context).includes(beta.id));
});

test('threadContext resolves segmentation and keeps thread exposures disjoint', async () => {
  const { store, dataDir, alpha, beta, segmentation } = await seededThreadStore();

  const alphaContext = await threadContext({
    store,
    dataDir,
    segmentation,
    threadId: 'thread_alpha',
    station: 'decide',
  });
  const betaContext = await threadContext({
    store,
    dataDir,
    segmentation,
    threadId: 'thread_beta',
    station: 'decide',
  });

  const alphaExposureIds = exposureIdsFromContext(alphaContext);
  const betaExposureIds = exposureIdsFromContext(betaContext);

  assert.deepEqual(alphaExposureIds, [alpha.id]);
  assert.deepEqual(betaExposureIds, [beta.id]);
  assert.deepEqual(
    alphaExposureIds.filter((id) => betaExposureIds.includes(id)),
    [],
  );
  assert.doesNotMatch(alphaContext, /Beta station context marker/);
  assert.doesNotMatch(betaContext, /Alpha station context marker/);
});

test('gatherContext without a thread remains whole-substrate context', async () => {
  const { store, dataDir } = await seededThreadStore();

  const context = await gatherContext('decide', { store, dataDir, limit: 10 });
  const contextWithUndefinedThreadOptions = await gatherContext('decide', {
    store,
    dataDir,
    limit: 10,
    threadId: undefined,
    threadExposureIds: undefined,
  });

  assert.equal(contextWithUndefinedThreadOptions, context);
  assert.match(context, /^Exposure: 2$/m);
  assert.match(context, /^SelfPattern: 2$/m);
  assert.match(context, /Alpha station context marker/);
  assert.match(context, /Beta station context marker/);
});

test('unknown threadId yields empty thread context without throwing', async () => {
  const { store, dataDir, segmentation } = await seededThreadStore();

  const context = await threadContext({
    store,
    dataDir,
    segmentation,
    threadId: 'thread_missing',
    station: 'decide',
  });

  assert.match(context, /^Exposure: 0$/m);
  assert.match(context, /^SelfPattern: 0$/m);
  assert.match(context, /^FootprintSample: 0$/m);
  assert.match(context, /## Recent exposure\n\n\(none\)/);
  assert.doesNotMatch(context, /Alpha station context marker/);
  assert.doesNotMatch(context, /Beta station context marker/);
  assert.deepEqual(exposureIdsFromContext(context), []);
});

test('gatherContext rejects unresolved thread membership unless explicitly empty', async () => {
  const { store, dataDir } = await seededThreadStore();

  await assert.rejects(
    gatherContext('decide', {
      store,
      dataDir,
      threadId: 'thread_missing',
      threadExposureResolver: async () => [],
    }),
    /resolved no exposure ids/,
  );

  const explicitEmpty = await gatherContext('decide', {
    store,
    dataDir,
    threadId: 'thread_missing',
    threadExposureIds: [],
  });
  assert.match(explicitEmpty, /^Exposure: 0$/m);
});

async function seededThreadStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-thread-context-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const alpha = await store.writeExposure({
    type: 'observation',
    statement: 'Alpha station context marker belongs only to thread alpha.',
    sourceId: 'thread-context-alpha',
    eventAt: '2026-06-28T01:00:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });
  const beta = await store.writeExposure({
    type: 'observation',
    statement: 'Beta station context marker belongs only to thread beta.',
    sourceId: 'thread-context-beta',
    eventAt: '2026-06-28T01:01:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });

  await store.processEngagement({
    exposureId: alpha.id,
    pattern: 'Alpha derived self marker belongs only to thread alpha.',
    confidence: 0.7,
    action: 'engaged',
    eventAt: '2026-06-28T01:02:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });
  await store.processEngagement({
    exposureId: beta.id,
    pattern: 'Beta derived self marker belongs only to thread beta.',
    confidence: 0.7,
    action: 'engaged',
    eventAt: '2026-06-28T01:03:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });

  return {
    store,
    dataDir,
    alpha,
    beta,
    segmentation: [
      { threadId: 'thread_alpha', exposureIds: [alpha.id] },
      { threadId: 'thread_beta', exposureIds: [beta.id] },
    ],
  };
}

function exposureIdsFromContext(context) {
  return [...context.matchAll(/<<< Exposure:([^>\s]+) >>>/g)].map((match) => match[1]);
}
