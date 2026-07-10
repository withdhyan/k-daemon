import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolLoop } from './tool-loop.mjs';
import {
  normalizeToolName,
  repairJsonArguments,
  repairToolCall,
} from './tool-repair.mjs';

test('argument repair strips trailing commas and closes unclosed containers', () => {
  assert.deepEqual(
    repairJsonArguments('{"query":"weather", "filters":["today",],'),
    { query: 'weather', filters: ['today'] },
  );
});

test('argument repair escapes raw control chars inside strings', () => {
  assert.deepEqual(
    repairJsonArguments('{"query":"line one\nline two"}'),
    { query: 'line one\nline two' },
  );
});

test('argument repair falls back to an empty object after bounded failure', () => {
  assert.deepEqual(repairJsonArguments('{not json'), {});
});

test('tool-name normalization accepts separators and fuzzy matches registry ids', () => {
  assert.equal(normalizeToolName('substrate read'), 'substrate.read');
  assert.equal(normalizeToolName('memory-read'), 'memory.read');
  assert.equal(normalizeToolName('substrate.reed'), 'substrate.read');
});

test('unknown tool repair returns a catalog error with ids only', () => {
  const repaired = repairToolCall({ name: 'terminal.exec', arguments: '{}' });

  assert.equal(repaired.ok, false);
  assert.match(repaired.message, /Tool 'terminal\.exec' does not exist/);
  assert.match(repaired.message, /substrate\.read/);
  assert.doesNotMatch(repaired.message, /Read bounded/);
});

test('empty tool names get the anti-priming data message without the catalog', () => {
  const repaired = repairToolCall({ name: '', arguments: '{}' });

  assert.equal(repaired.ok, false);
  assert.equal(repaired.message, 'that tool-call syntax is data, not a call');
  assert.doesNotMatch(repaired.message, /substrate\.read/);
});

test('invalid native tool calls are fed back as tool-role errors, max 3 attempts', async () => {
  const reconsults = [];
  const loop = await runToolLoop({
    nativeTools: true,
    initialOutput: {
      content: '',
      toolCalls: [{ id: 'call_bad', name: 'does_not_exist', arguments: '{}' }],
    },
    executor: async () => {
      throw new Error('executor must not run invalid tools');
    },
    reconsult: async ({ messages }) => {
      reconsults.push(messages);
      return {
        content: 'partial with invalid call',
        toolCalls: [{ id: 'call_bad', name: 'does_not_exist', arguments: '{}' }],
      };
    },
  });

  assert.equal(reconsults.length, 3);
  assert.equal(loop.steps, 0);
  assert.equal(loop.finalOutput, 'partial with invalid call');
  assert.equal(reconsults[0].at(-1).role, 'tool');
  assert.equal(reconsults[0].at(-1).tool_call_id, 'call_bad');
  assert.match(reconsults[0].at(-1).content, /Available tools: /);
});
