import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProvenance,
  classifyTurnSensitivity,
  requiresSovereignLane,
  SENSITIVITY_CLASSES,
} from './sensitivity.mjs';

test('a generic public question with no substrate routes to the frontier', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'You are K.\n\nWhat is the capital of France?',
    substratePresent: false,
    provenance: ['public'],
  });
  assert.equal(result.sensitivity, 'public');
  assert.equal(result.sovereign, false);
  assert.equal(requiresSovereignLane(result), false);
});

test('system/internal provenance stays non-sovereign (frontier lane)', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'You are K.\n\nWhat is the capital of France?',
    substratePresent: false,
    provenance: ['system', 'public'],
  });
  assert.equal(result.sensitivity, 'internal');
  assert.equal(result.sovereign, false);
});

test('SEC-001: substrate present forces the sensitive floor regardless of user message', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'You are K.\n\nWhat is 2 + 2?',
    substratePresent: true,
    provenance: ['system'],
  });
  assert.equal(result.sensitivity, 'sensitive');
  assert.equal(result.sovereign, true);
  assert.equal(result.reason, 'substrate_block_present');
});

test('substrate/personal provenance routes to the sovereign lane', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'context merged',
    substratePresent: false,
    provenance: ['substrate'],
  });
  assert.equal(result.sovereign, true);
  assert.ok(result.sensitivity === 'personal' || result.sensitivity === 'sensitive');
});

test('genomic provenance is the crown-jewel sensitive floor', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'context merged',
    provenance: ['GenomicTrait'],
  });
  assert.equal(result.sensitivity, 'sensitive');
  assert.equal(result.sovereign, true);
});

test('fail-closed: unknown provenance is treated as sensitive', () => {
  assert.equal(classifyProvenance('some-novel-source'), 'sensitive');
  const result = classifyTurnSensitivity({
    assembledPrompt: 'hi',
    provenance: ['some-novel-source'],
  });
  assert.equal(result.sovereign, true);
});

test('content signal backstop raises the floor when genome text leaks into the prompt', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'Interpret my genome rs4680 result',
    substratePresent: false,
    provenance: ['public'],
  });
  assert.equal(result.sensitivity, 'sensitive');
  assert.equal(result.sovereign, true);
});

test('content signals never LOWER a floor set by provenance', () => {
  const result = classifyTurnSensitivity({
    assembledPrompt: 'plain public text',
    provenance: ['substrate'],
  });
  assert.equal(result.sovereign, true);
});

test('the sensitivity enum is closed and ordered', () => {
  assert.deepEqual(SENSITIVITY_CLASSES, ['public', 'internal', 'personal', 'sensitive']);
});
