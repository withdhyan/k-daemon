import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamingThinkScrubber, stripThinkBlocks } from './think-scrubber.mjs';

test('streaming scrubber strips split-across-delta think tags and keeps visible prose', () => {
  const scrubber = new StreamingThinkScrubber();
  const visible = [
    scrubber.feed('visible\n<th'),
    scrubber.feed('ink>private reasoning</think> answer'),
    scrubber.flush(),
  ].join('');

  assert.equal(visible, 'visible\n answer');
  assert.equal(scrubber.reasoning, 'private reasoning');
});

test('streaming scrubber discards unterminated think blocks on flush', () => {
  const scrubber = new StreamingThinkScrubber();
  const visible = scrubber.feed('ok\n<thinking>hidden') + scrubber.flush();

  assert.equal(visible, 'ok\n');
  assert.equal(scrubber.reasoning, 'hidden');
});

test('mid-line prose mentioning think tags survives', () => {
  const scrubber = new StreamingThinkScrubber();
  const visible = scrubber.feed('Use <think> as data, not a block.') + scrubber.flush();

  assert.equal(visible, 'Use <think> as data, not a block.');
});

test('non-stream scrubber returns clean content and reasoning', () => {
  const result = stripThinkBlocks('<reasoning>secret</reasoning>public');

  assert.deepEqual(result, { content: 'public', reasoning: 'secret' });
});
