import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { readRecentDiagnostics } from './diagnostics.mjs';
import {
  SELF_REVIEW_NUDGE_EVERY_TURNS,
  handleChatStream,
  resetSelfReviewTurnCounterForTests,
} from '../../daemon/routes/chat.mjs';

// A minimal mock ServerResponse that records SSE writes.
function mockResponse() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(String(chunk));
      this.writableEnded = true;
    },
    body() {
      return chunks.join('');
    },
    events() {
      return this.body()
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const lines = block.split('\n');
          const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
          return { event, data: data ? JSON.parse(data) : null };
        });
    },
  };
}

function mockRequest(payload) {
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

test('POST /api/chat streams token then done events', async () => {
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    runTurn: async ({ onToken }) => {
      onToken('hi ');
      onToken('there');
      return { content: 'hi there', lane: 'frontier', sensitivity: 'public', sovereign: false, steps: 0, held: [] };
    },
  });
  const events = response.events();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  const tokens = events.filter((e) => e.event === 'token').map((e) => e.data.text);
  assert.deepEqual(tokens, ['hi ', 'there']);
  const done = events.find((e) => e.event === 'done');
  assert.equal(done.data.ok, true);
  assert.equal(done.data.lane, 'frontier');
});

test('POST /api/chat appends one diagnostic line after done', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-chat-diagnostics-'));
  const response = mockResponse();

  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    dataDir,
    runTurn: async ({ onToken }) => {
      onToken('hi');
      return {
        content: 'hi',
        lane: 'sovereign',
        sensitivity: 'sensitive',
        sovereign: true,
        steps: 1,
        held: [{ id: 'tool.pending' }],
        glaze: { score: 0.8, hits: [] },
      };
    },
  });

  const [line] = await waitForDiagnostics(dataDir);
  assert.equal(line.lane, 'sovereign');
  assert.equal(line.sensitivity, 'sensitive');
  assert.equal(line.sovereign, true);
  assert.equal(line.steps, 1);
  assert.equal(line.held, 1);
  assert.equal(line.ok, true);
  assert.equal(line.glazeScore, 0.8);
  assert.equal(typeof line.ttftMs, 'number');
  assert.equal(typeof line.totalMs, 'number');
});

test('POST /api/chat diagnostics failures do not affect the response', async () => {
  const dataDir = path.join(os.tmpdir(), `cs-k-chat-diagnostics-file-${process.pid}-${Date.now()}`);
  await fs.writeFile(dataDir, 'not a directory', 'utf8');
  const response = mockResponse();

  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    dataDir,
    runTurn: async ({ onToken }) => {
      onToken('ok');
      return { content: 'ok', lane: 'sovereign', sensitivity: 'sensitive', sovereign: true, steps: 0, held: [] };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.events().find((event) => event.event === 'done').data.ok, true);
});

test('POST /api/chat done event carries glaze score when present', async () => {
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    runTurn: async () => ({
      content: 'unchanged',
      lane: 'frontier',
      sensitivity: 'public',
      sovereign: false,
      steps: 0,
      held: [],
      glaze: { score: 0.85, hits: [{ pattern: 'superlative praise' }] },
    }),
  });

  const done = response.events().find((e) => e.event === 'done');
  assert.deepEqual(done.data.glaze, { score: 0.85 });
});

test('POST /api/chat passes selfReview on every Nth turn and not before', async () => {
  resetSelfReviewTurnCounterForTests();
  const flags = [];

  for (let i = 0; i < SELF_REVIEW_NUDGE_EVERY_TURNS; i += 1) {
    const response = mockResponse();
    await handleChatStream(mockRequest({ message: `hello ${i}` }), response, {
      runTurn: async (input) => {
        flags.push(input.selfReview);
        return {
          content: 'ok',
          lane: 'sovereign',
          sensitivity: 'sensitive',
          sovereign: true,
          steps: 0,
          held: [],
        };
      },
    });
  }

  assert.deepEqual(flags.slice(0, -1), Array(SELF_REVIEW_NUDGE_EVERY_TURNS - 1).fill(false));
  assert.equal(flags.at(-1), true);
});

test('POST /api/chat streams real model-call deltas through runAgentTurn', async () => {
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    deps: {
      frontierModelCall: async () => {
        throw new Error('frontier must not run');
      },
      sovereignModelCall: async ({ onToken }) => {
        onToken('hi ');
        onToken('there');
        return 'hi there';
      },
    },
  });

  const events = response.events();
  assert.deepEqual(events.filter((e) => e.event === 'token').map((e) => e.data.text), ['hi ', 'there']);
  const done = events.find((e) => e.event === 'done');
  assert.equal(done.data.content, 'hi there');
  assert.equal(done.data.lane, 'sovereign');
});

test('POST /api/chat writes SSE comment keep-alives during a slow turn', async () => {
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: 'hello' }), response, {
    keepAliveIntervalMs: 5,
    runTurn: async () => {
      await delay(18);
      return { content: 'ok', lane: 'sovereign', sensitivity: 'sensitive', sovereign: true, steps: 0, held: [] };
    },
  });

  assert.match(response.body(), /: ping\n\n/);
  assert.doesNotMatch(response.body(), /event: ping/);
});

test('POST /api/chat aborts the in-flight turn when the client disconnects', async () => {
  const request = mockRequest({ message: 'private' });
  const response = mockResponse();
  const started = deferred();
  let signalAborted = false;

  const stream = handleChatStream(request, response, {
    deps: {
      frontierModelCall: async () => {
        throw new Error('frontier must not run');
      },
      sovereignModelCall: async ({ signal }) => {
        started.resolve(signal);
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('abort was not observed')), 100);
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            signalAborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    },
  });

  const signal = await started.promise;
  assert.equal(signal.aborted, false);
  request.emit('close');
  await stream;

  assert.equal(signal.aborted, true);
  assert.equal(signalAborted, true);
  assert.equal(response.events().find((e) => e.event === 'error').data.error, 'sovereign_lane_unavailable');
});

test('an empty message returns a 400 JSON error, no stream', async () => {
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: '' }), response, {
    runTurn: async () => {
      throw new Error('should not run');
    },
  });
  assert.equal(response.statusCode, 400);
  assert.ok(response.body().includes('empty_message'));
});

test('POST /api/chat sovereign floor holds when substrate context is empty', async () => {
  const response = mockResponse();
  const calls = { frontier: 0, sovereign: 0 };

  await handleChatStream(mockRequest({ message: 'what should I do?' }), response, {
    substrateBlock: '',
    deps: {
      frontierModelCall: async () => {
        calls.frontier += 1;
        return 'LEAK';
      },
      sovereignModelCall: async () => {
        calls.sovereign += 1;
        return 'sovereign answer';
      },
    },
  });

  assert.equal(calls.sovereign, 1);
  assert.equal(calls.frontier, 0);
  const done = response.events().find((e) => e.event === 'done');
  assert.equal(done.data.lane, 'sovereign');
  assert.equal(done.data.sovereign, true);
});

test('SEC-002: a sovereign-lane failure emits a silenced error event, never content', async () => {
  const { SovereignLaneError } = await import('../agent/chat.mjs');
  const response = mockResponse();
  await handleChatStream(mockRequest({ message: 'private' }), response, {
    runTurn: async () => {
      throw new SovereignLaneError('sovereign lane unavailable — turn silenced');
    },
  });
  const events = response.events();
  const error = events.find((e) => e.event === 'error');
  assert.equal(error.data.error, 'sovereign_lane_unavailable');
  assert.equal(error.data.silenced, true);
  assert.ok(!response.body().includes('event: token'));
});

test('SEC-002: a mid-stream tool-less sovereign failure streams the partial but silences the remainder (no frontier, no upstream echo)', async () => {
  const response = mockResponse();
  const calls = { frontier: 0, sovereign: 0 };

  await handleChatStream(mockRequest({ message: 'private' }), response, {
    deps: {
      frontierModelCall: async () => {
        calls.frontier += 1;
        return 'LEAK';
      },
      sovereignModelCall: async ({ onToken }) => {
        calls.sovereign += 1;
        onToken('partial');
        throw new Error('upstream body: SECRET-CHAT-FRAGMENT');
      },
    },
  });

  const events = response.events();
  // Tool-less sovereign turns stream live (founder decision, 2026-07-03): the
  // already-streamed partial is the founder's own sovereign content and IS shown.
  assert.deepEqual(events.filter((e) => e.event === 'token').map((e) => e.data.text), ['partial']);
  // The REMAINDER still silences: bounded error, no done, no frontier, no upstream echo.
  assert.equal(events.find((e) => e.event === 'error').data.error, 'sovereign_lane_unavailable');
  assert.equal(events.some((e) => e.event === 'done'), false);
  assert.equal(calls.sovereign, 1);
  assert.equal(calls.frontier, 0);
  assert.ok(!response.body().includes('SECRET-CHAT-FRAGMENT'));
  assert.ok(!response.body().includes('LEAK'));
});

test('grounds the turn: forwards substrateBlock + prepends baseSystemPrompt, marks substratePresent', async () => {
  const response = mockResponse();
  let captured;
  await handleChatStream(mockRequest({ message: 'what am I focused on?' }), response, {
    baseSystemPrompt: 'You are K.',
    substrateBlock: 'EXPOSURE: Meditations by Marcus Aurelius',
    runTurn: async (input) => {
      captured = input;
      return { content: 'ok', lane: 'sovereign', sensitivity: 'sensitive', sovereign: true, steps: 0, held: [] };
    },
  });
  assert.equal(captured.substrateBlock, 'EXPOSURE: Meditations by Marcus Aurelius');
  assert.equal(captured.substratePresent, true);
  assert.equal(captured.sovereignFloor, true);
  assert.equal(captured.systemPrompt, 'You are K.');
  // done event still fine
  assert.equal(response.events().find((e) => e.event === 'done').data.ok, true);
});

test('POST /api/chat passes the parsed message into substrate context assembly', async () => {
  const response = mockResponse();
  let builderMessage;
  let captured;

  await handleChatStream(mockRequest({ message: 'what context matters now?' }), response, {
    baseSystemPrompt: 'You are K.',
    buildSubstrateBlock: async (userMessage) => {
      builderMessage = userMessage;
      return `EXPOSURE: relevant to ${userMessage}`;
    },
    runTurn: async (input) => {
      captured = input;
      return { content: 'ok', lane: 'sovereign', sensitivity: 'sensitive', sovereign: true, steps: 0, held: [] };
    },
  });

  assert.equal(builderMessage, 'what context matters now?');
  assert.equal(captured.substrateBlock, 'EXPOSURE: relevant to what context matters now?');
  assert.equal(captured.substratePresent, true);
});

test('caller-supplied systemPrompt extends the base persona, does not replace it', async () => {
  const response = mockResponse();
  let captured;
  await handleChatStream(
    mockRequest({ message: 'hi', systemPrompt: 'Answer in French.' }),
    response,
    {
      baseSystemPrompt: 'You are K.',
      runTurn: async (input) => {
        captured = input;
        return { content: 'ok', lane: 'frontier', sensitivity: 'public', sovereign: false, steps: 0, held: [] };
      },
    },
  );
  assert.equal(captured.systemPrompt, 'You are K.\n\nAnswer in French.');
  // no substrate this turn → not present
  assert.equal(captured.substratePresent, false);
  assert.equal(captured.sovereignFloor, true);
  assert.equal(captured.substrateBlock, undefined);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiagnostics(dataDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lines = await readRecentDiagnostics({ dataDir, limit: 10 });
    if (lines.length > 0) return lines;
    await delay(5);
  }
  return [];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
