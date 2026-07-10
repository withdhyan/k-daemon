import assert from 'node:assert/strict';
import test from 'node:test';

import { vrsdSelect } from './vrsd.mjs';

test('VRSD diversifies by selecting the vector that best improves the selected sum', () => {
  const selected = vrsdSelect(
    [1, 0],
    [
      doc('upper-topic', [0.8, 0.6]),
      doc('same-side-neighbor', [0.7, 0.7]),
      doc('lower-topic', [0.8, -0.6]),
    ],
    2,
  );

  assert.deepEqual(selected.map((candidate) => candidate.id), [
    'upper-topic',
    'lower-topic',
  ]);
});

function doc(id, embedding) {
  return { id, embedding, content: id, metadata: {} };
}
