import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkNovelty,
  frequencyToMu,
  levyExplore,
  levyStepSize,
} from './levy.mjs';

test('fixed Lévy novelty check rejects explored items that only duplicate selected ids', () => {
  const selected = [doc('already-selected', [1, 0])];
  const explored = [doc('already-selected', [1, 0])];

  assert.equal(checkNovelty(selected, explored), false);
  assert.equal(checkNovelty(selected, [doc('new-territory', [0, 1])]), true);
});

test('levyExplore uses frequency mapped Pareto steps to select distant unselected memory', () => {
  const selected = new Set(['local']);
  const explored = levyExplore(
    [1, 0],
    [
      doc('local', [1, 0]),
      doc('near', [0.95, 0.05]),
      doc('distant', [0, 1]),
      doc('opposite', [-1, 0]),
    ],
    selected,
    {
      frequency: 'weekly',
      minDistance: 0.8,
      nWalks: 1,
      random: () => 0.5,
    },
  );

  assert.equal(frequencyToMu('weekly'), 2);
  assert.equal(levyStepSize(2, { random: () => 0.5 }), 2);
  assert.deepEqual(explored.map((item) => item.id), ['distant']);
});

function doc(id, embedding) {
  return { id, embedding, content: id, metadata: {} };
}
