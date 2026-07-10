import assert from 'node:assert/strict';
import test from 'node:test';

import { PERSONALITY_ANCHOR_THRESHOLD, anchorTest } from './drift.mjs';

test('anchorTest keeps healthy K-style answers above reset threshold', () => {
  const result = anchorTest({
    personaText: 'K speaks directly and grounds in evidence.',
    answers: [
      'consider: keep the answer terse and cite the fetched source.',
      'state: recovery is low; observe HRV before adding strain.',
    ],
  });

  assert.equal(result.reset, false);
  assert.equal(result.threshold, PERSONALITY_ANCHOR_THRESHOLD);
  assert(result.score >= PERSONALITY_ANCHOR_THRESHOLD);
});

test('anchorTest resets below 0.85 on personality drift markers', () => {
  const result = anchorTest({
    personaText: 'K speaks directly and avoids praise creep.',
    answers: [
      'Great question. I think you definitely might want to consider doing that.',
      "I'm not sure but absolutely, great work.",
    ],
  });

  assert.equal(result.reset, true);
  assert(result.score < PERSONALITY_ANCHOR_THRESHOLD);
  assert.equal(result.severity, 'critical');
});
