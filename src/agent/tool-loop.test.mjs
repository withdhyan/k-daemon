import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolLoop, DEFAULT_MAX_STEPS } from './tool-loop.mjs';

test('read-only calls in one reply run in a single parallel batch', async () => {
  const order = [];
  let concurrent = 0;
  let peak = 0;
  const loop = await runToolLoop({
    initialOutput: [
      '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
      '<tool_call>{"name":"memory.read","arguments":{"key":"a"}}</tool_call>',
    ].join('\n'),
    executor: async (id) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      order.push(id);
      return { ok: true, output: `${id}-out` };
    },
    reconsult: async () => 'no more tool calls, final answer',
  });
  assert.equal(peak, 2, 'read-only batch should run in parallel');
  assert.equal(loop.executed.length, 2);
  assert.equal(loop.finalOutput, 'no more tool calls, final answer');
  assert.equal(loop.steps, 1);
});

test('a mutating tool is HELD, not executed', async () => {
  let executed = false;
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"memory.write","arguments":{"key":"k","value":"v"}}</tool_call>',
    executor: async () => {
      executed = true;
      return { ok: true };
    },
    reconsult: async () => 'done',
  });
  assert.equal(executed, false);
  assert.equal(loop.held.length, 1);
  assert.equal(loop.held[0].id, 'memory.write');
});

test('the loop is bounded at DEFAULT_MAX_STEPS', async () => {
  let calls = 0;
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
    executor: async () => {
      calls += 1;
      return { ok: true, output: 'x' };
    },
    // Always request another tool call → would loop forever if unbounded.
    reconsult: async () => '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
  });
  assert.equal(loop.steps, DEFAULT_MAX_STEPS);
  assert.ok(calls <= DEFAULT_MAX_STEPS + 1);
});

test('SEC-001: a step surfacing sensitive tool output pins reconsult to the sovereign lane', async () => {
  const lanes = [];
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
    sovereign: false,
    executor: async (id) => ({
      ok: true,
      output: 'substrate context',
      sensitive: true,
      provenance: ['substrate'],
    }),
    reconsult: async ({ sovereign }) => {
      lanes.push(sovereign);
      return 'final answer, no tool calls';
    },
  });
  assert.equal(lanes[0], true, 'reconsult must be told to use the sovereign lane');
  assert.equal(loop.sovereign, true);
});

test('a turn that started sovereign never de-escalates', async () => {
  const lanes = [];
  await runToolLoop({
    initialOutput: '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
    sovereign: true,
    executor: async () => ({ ok: true, output: 'x', sensitive: false, provenance: ['public'] }),
    reconsult: async ({ sovereign }) => {
      lanes.push(sovereign);
      return 'done';
    },
  });
  assert.equal(lanes[0], true);
});

test('an explicit tool allowlist holds known but unadvertised tool calls', async () => {
  let executed = false;
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"memory.read","arguments":{"key":"a"}}</tool_call>',
    allowedToolIds: ['admin.parse_intake'],
    executor: async () => {
      executed = true;
      return { ok: true };
    },
    reconsult: async () => 'done',
  });

  assert.equal(executed, false);
  assert.equal(loop.held.length, 1);
  assert.equal(loop.held[0].id, 'memory.read');
  assert.equal(loop.held[0].reason, 'unknown_tool');
});

test('an executor throw is captured as a failed result, not a crash', async () => {
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
    executor: async () => {
      throw new Error('boom');
    },
    reconsult: async () => 'recovered',
  });
  assert.equal(loop.executed[0].ok, false);
  assert.equal(loop.finalOutput, 'recovered');
});

test('no tool calls → loop returns the initial output unchanged', async () => {
  const loop = await runToolLoop({
    initialOutput: 'just a plain answer',
    executor: async () => ({ ok: true }),
    reconsult: async () => 'should not be called',
  });
  assert.equal(loop.steps, 0);
  assert.equal(loop.finalOutput, 'just a plain answer');
});
