import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentTurn, SovereignLaneError, TOOL_RECONSULT_INSTRUCTION } from './chat.mjs';
import { GLAZE_SURFACE_THRESHOLD } from './truth.mjs';

function seams() {
  const calls = { frontier: 0, sovereign: 0 };
  return {
    calls,
    frontierModelCall: async () => {
      calls.frontier += 1;
      return 'frontier says hello';
    },
    sovereignModelCall: async () => {
      calls.sovereign += 1;
      return 'sovereign says hello';
    },
  };
}

test('a non-sensitive turn routes to the frontier lane', async () => {
  const deps = seams();
  const result = await runAgentTurn(
    { userMessage: 'What is the capital of France?' },
    deps,
  );
  assert.equal(result.lane, 'frontier');
  assert.equal(result.sovereign, false);
  assert.equal(deps.calls.frontier, 1);
  assert.equal(deps.calls.sovereign, 0);
  assert.equal(result.content, 'frontier says hello');
});

test('glaze check surfaces sycophantic final content without rewriting', async () => {
  const content = "Absolutely, you're right, that's a brilliant point!";
  const warnings = [];
  const result = await runAgentTurn(
    { userMessage: 'validate this' },
    {
      frontierModelCall: async () => content,
      logger: { warn: (line) => warnings.push(line) },
    },
  );

  assert.equal(result.content, content);
  assert.ok(result.glaze.score > GLAZE_SURFACE_THRESHOLD);
  assert.ok(result.glaze.hits.some((hit) => hit.pattern === 'superlative praise'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /glaze-check score=/);
});

test('glaze check stays absent on clean final content', async () => {
  const result = await runAgentTurn(
    { userMessage: 'what changed?' },
    {
      frontierModelCall: async () =>
        'hrv: 54ms. third consecutive drop. correlates with late trading sessions.',
      logger: { warn: () => assert.fail('clean text must not warn') },
    },
  );

  assert.equal(result.glaze, undefined);
});

test('SEC-001: a turn with a substrate block routes to the sovereign lane', async () => {
  const deps = seams();
  const result = await runAgentTurn(
    {
      userMessage: 'What should I do today?',
      substrateBlock: '<substrate>recent exposures ...</substrate>',
      provenance: ['substrate'],
    },
    deps,
  );
  assert.equal(result.lane, 'sovereign');
  assert.equal(result.sovereign, true);
  assert.equal(deps.calls.sovereign, 1);
  assert.equal(deps.calls.frontier, 0, 'sensitive turn must NEVER touch the frontier');
});

test('SEC-001: substratePresent flag forces sovereign even without a block string', async () => {
  const deps = seams();
  const result = await runAgentTurn(
    { userMessage: 'hi', substratePresent: true },
    deps,
  );
  assert.equal(result.sovereign, true);
  assert.equal(deps.calls.frontier, 0);
});

test('sovereignFloor forces sovereign even with empty substrate', async () => {
  const deps = seams();
  const result = await runAgentTurn(
    { userMessage: 'hi', sovereignFloor: true },
    deps,
  );
  assert.equal(result.lane, 'sovereign');
  assert.equal(result.sovereign, true);
  assert.equal(result.sensitivity, 'sensitive');
  assert.equal(deps.calls.sovereign, 1);
  assert.equal(deps.calls.frontier, 0);
});

test('SEC-002: a sovereign-lane failure SILENCES and NEVER falls back to the frontier', async () => {
  const calls = { frontier: 0, sovereign: 0 };
  await assert.rejects(
    () =>
      runAgentTurn(
        { userMessage: 'private question', substratePresent: true },
        {
          frontierModelCall: async () => {
            calls.frontier += 1;
            return 'LEAK';
          },
          sovereignModelCall: async () => {
            calls.sovereign += 1;
            throw new Error('502 upstream');
          },
        },
      ),
    (error) => error instanceof SovereignLaneError && error.silence === true,
  );
  assert.equal(calls.sovereign, 1);
  assert.equal(calls.frontier, 0, 'the frontier must NOT be called on sovereign failure');
});

test('the sovereign lane error never echoes the upstream body', async () => {
  try {
    await runAgentTurn(
      { userMessage: 'x', substratePresent: true },
      {
        sovereignModelCall: async () => {
          throw new Error('upstream body: SECRET-CHAT-FRAGMENT');
        },
      },
    );
    assert.fail('expected a SovereignLaneError');
  } catch (error) {
    assert.ok(error instanceof SovereignLaneError);
    assert.ok(!error.message.includes('SECRET-CHAT-FRAGMENT'));
  }
});

test('SEC-002: tool-less sovereign turn streams live, and a mid-stream failure still silences the remainder', async () => {
  // Founder decision (2026-07-03): tool-less sovereign turns stream live — the
  // already-streamed partial is the founder's own sovereign content on their own
  // device; SEC-002 still silences the REMAINDER (throws, no frontier fallback).
  const tokens = [];
  await assert.rejects(
    () =>
      runAgentTurn(
        {
          userMessage: 'private question',
          substratePresent: true,
          onToken: (token) => tokens.push(token),
        },
        {
          sovereignModelCall: async ({ onToken }) => {
            onToken('partial');
            throw new Error('upstream failed');
          },
        },
      ),
    (error) => error instanceof SovereignLaneError && error.silence === true,
  );

  // Live-streamed partial IS shown (not unseen); the turn still errors/silences.
  assert.deepEqual(tokens, ['partial']);
});

test('SEC-002: a TOOLS-enabled sovereign turn still defers — no partial tokens on mid-stream failure', async () => {
  const tokens = [];
  await assert.rejects(
    () =>
      runAgentTurn(
        {
          userMessage: 'private question',
          substratePresent: true,
          tools: true,
          onToken: (token) => tokens.push(token),
        },
        {
          sovereignModelCall: async ({ onToken }) => {
            onToken('partial');
            throw new Error('upstream failed');
          },
          toolExecutor: async () => { throw new Error('executor must not run'); },
        },
      ),
    (error) => error instanceof SovereignLaneError && error.silence === true,
  );

  // Tool turns keep the strict buffer — tool-call syntax must not render mid-stream.
  assert.deepEqual(tokens, []);
});

test('with tools enabled, a mutating tool call is HELD (advisory-only)', async () => {
  const deps = {
    frontierModelCall: async ({ user }) => {
      // First call proposes a mutating tool; reconsult returns a final answer.
      if (user.includes('tool_response')) return 'final answer';
      return '<tool_call>{"name":"memory.write","arguments":{"key":"k","value":"v"}}</tool_call>';
    },
    sovereignModelCall: async () => 'unused',
    toolExecutor: async () => {
      throw new Error('executor must not run a held tool');
    },
  };
  const result = await runAgentTurn(
    { userMessage: 'remember this', tools: true },
    deps,
  );
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].id, 'memory.write');
});

test('tool reconsult prompt requires inline citations and a Sources list', async () => {
  let calls = 0;
  let reconsultUser;

  await runAgentTurn(
    {
      userMessage: 'look up the weather',
      tools: true,
      toolGrants: new Set(['web.search']),
    },
    {
      frontierModelCall: async ({ user }) => {
        calls += 1;
        if (calls === 1) {
          return '<tool_call>{"name":"web.search","arguments":{"query":"weather chiang mai"}}</tool_call>';
        }
        reconsultUser = user;
        return '31C [1]\n\nSources:\n[1] https://weather.example';
      },
      sovereignModelCall: async () => {
        throw new Error('sovereign must not run');
      },
      toolExecutor: async () => ({ ok: true, output: '1. Weather (https://weather.example)' }),
    },
  );

  assert.ok(TOOL_RECONSULT_INSTRUCTION.includes('cite sources inline as [n]'));
  assert.ok(TOOL_RECONSULT_INSTRUCTION.includes('"Sources:" list'));
  assert.ok(TOOL_RECONSULT_INSTRUCTION.includes('never cite a URL not present in tool results'));
  assert.ok(reconsultUser.includes(TOOL_RECONSULT_INSTRUCTION));
});

test('sovereign tool turns use native schemas and tool-role reconsult messages', async () => {
  let calls = 0;
  let firstRequest;
  let reconsultRequest;

  const result = await runAgentTurn(
    {
      userMessage: 'read substrate',
      substratePresent: true,
      tools: true,
      onToken: () => {},
    },
    {
      frontierModelCall: async () => {
        throw new Error('frontier must not run');
      },
      sovereignModelCall: async (request) => {
        calls += 1;
        if (calls === 1) {
          firstRequest = request;
          return {
            content: '',
            toolCalls: [{
              id: 'call_substrate',
              name: 'substrate.read',
              arguments: '{"query":"focus"}',
            }],
          };
        }
        reconsultRequest = request;
        return { content: 'final answer from tool result' };
      },
      toolExecutor: async (id, args) => {
        assert.equal(id, 'substrate.read');
        assert.deepEqual(args, { query: 'focus' });
        return { ok: true, output: 'substrate output', sensitive: true, provenance: ['substrate'] };
      },
    },
  );

  assert.equal(result.content, 'final answer from tool result');
  assert.equal(result.steps, 1);
  assert.ok(Array.isArray(firstRequest.tools));
  assert.ok(firstRequest.tools.some((tool) => tool.function.name === 'substrate.read'));
  assert.ok(!firstRequest.system.includes('<tools>'));
  assert.ok(Array.isArray(reconsultRequest.messages));
  assert.ok(reconsultRequest.messages.some((message) =>
    message.role === 'tool' &&
    message.tool_call_id === 'call_substrate' &&
    message.name === 'substrate.read' &&
    message.content.includes('substrate output')));
});

test('streaming sink receives tokens', async () => {
  const tokens = [];
  await runAgentTurn(
    { userMessage: 'hello', onToken: (t) => tokens.push(t) },
    seams(),
  );
  assert.ok(tokens.join('').includes('frontier says hello'));
});

test('self-review nudge runs after finalize on a bounded snapshot and does not alter result', async () => {
  const seen = deferred();
  const result = await runAgentTurn(
    {
      userMessage: 'hello',
      systemPrompt: 'You are K.',
      selfReview: true,
      dataDir: '/tmp/cs-k-test-data',
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    },
    {
      frontierModelCall: async () => 'frontier answer',
      runSelfReview: async (input) => {
        seen.resolve(input);
        return { ok: true, staged: [], rejected: [] };
      },
      selfReviewSingleCall: async () => ({ proposals: [] }),
    },
  );

  assert.equal(result.content, 'frontier answer');
  const review = await seen.promise;
  assert(review.conversationSnapshot.length <= 8 * 1024);
  assert.match(review.conversationSnapshot, /## system\nYou are K\./);
  assert.match(review.conversationSnapshot, /## user\nhello/);
  assert.match(review.conversationSnapshot, /## content\nfrontier answer/);
});

test('streamed model-call deltas reach onToken without a duplicate full text event', async () => {
  const tokens = [];
  const result = await runAgentTurn(
    {
      userMessage: 'hello',
      sovereignFloor: true,
      onToken: (token) => tokens.push(token),
    },
    {
      frontierModelCall: async () => {
        throw new Error('frontier must not run');
      },
      sovereignModelCall: async ({ onToken }) => {
        onToken('hel');
        onToken('lo');
        return 'hello';
      },
    },
  );

  assert.equal(result.content, 'hello');
  assert.deepEqual(tokens, ['hel', 'lo']);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('history renders as a bounded transcript and reaches the model prompt', async () => {
  const { runAgentTurn, renderHistory } = await import('./chat.mjs');

  // Rendering: roles map, junk entries drop, empty → ''.
  assert.equal(renderHistory([]), '');
  assert.equal(renderHistory([{ role: 'x', content: 'nope' }]), '');
  const rendered = renderHistory([
    { role: 'user', content: 'My favorite number is 47.' },
    { role: 'assistant', content: 'OK' },
  ]);
  assert.ok(rendered.startsWith('Conversation so far:'));
  assert.ok(rendered.includes('founder: My favorite number is 47.'));
  assert.ok(rendered.includes('K: OK'));

  // Bounding: only the last HISTORY_MAX_MESSAGES survive.
  const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
  const bounded = renderHistory(many);
  assert.ok(!bounded.includes('msg-9'));
  assert.ok(bounded.includes('msg-29'));

  // The turn threads the transcript into the model's user content.
  let seenUser;
  const result = await runAgentTurn(
    {
      userMessage: 'What is my favorite number?',
      history: [
        { role: 'user', content: 'My favorite number is 47.' },
        { role: 'assistant', content: 'OK' },
      ],
      substrateBlock: 'EXPOSURE: x',
      sovereignFloor: true,
      onToken: () => {},
    },
    {
      sovereignModelCall: async ({ user }) => {
        seenUser = user;
        return '47.';
      },
    },
  );
  assert.equal(result.content, '47.');
  assert.ok(seenUser.includes('founder: My favorite number is 47.'));
  assert.ok(seenUser.endsWith('founder: What is my favorite number?'));
});
