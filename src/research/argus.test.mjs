import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBlindSpotIndex,
  injectBlindSpots,
} from './argus.mjs';

test('ARGUS injects an isolated outlier above the relevance floor', () => {
  const clusteredA = doc('cluster-a', [1, 0]);
  const clusteredB = doc('cluster-b', [0.98, 0.02]);
  const outlier = doc('isolated-outlier', [0, 1]);
  const allDocs = [clusteredA, clusteredB, outlier];

  const index = buildBlindSpotIndex(allDocs, { isolationThreshold: 0.7 });
  const injected = injectBlindSpots(
    [0, 1],
    [clusteredA, clusteredB],
    index,
    { relevanceFloor: 0.9, maxInject: 1 },
  );

  assert.deepEqual(index.map((entry) => entry.doc.id), ['isolated-outlier']);
  assert.deepEqual(injected.map((candidate) => candidate.id), [
    'cluster-a',
    'cluster-b',
    'isolated-outlier',
  ]);
});

function doc(id, embedding) {
  return { id, embedding, content: id, metadata: {} };
}
