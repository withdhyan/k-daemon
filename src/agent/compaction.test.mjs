import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CHAT_HISTORY_MAX_CHARS,
  handleChatStream,
} from '../../daemon/routes/chat.mjs';
import {
  runAgentTurn,
  summarizeHistoryWithSovereign,
} from './chat.mjs';
import {
  compactHistory,
  OMITTED_MARKER,
  SUMMARY_PREFIX,
} from './compaction.mjs';

test('short history is returned untouched and does not call summarize', async () => {
  const history = [
    { role: 'user', content: 'My favorite number is 47.' },
    { role: 'assistant', content: 'OK.' },
  ];
  let called = false;

  const result = await compactHistory({
    history,
    maxChars: 10_000,
    keepTailChars: 5_000,
    summarize: () => {
      called = true;
      return 'must not run';
    },
  });

  assert.equal(result.compacted, false);
  assert.equal(result.history, history);
  assert.equal(result.summaryEntry, undefined);
  assert.equal(called, false);
});

test('long history becomes protected head plus redacted summary plus verbatim tail', async () => {
  const { history, head, tail, lastRequest } = longHistoryFixture();
  let summarizedText = '';

  const result = await compactHistory({
    history,
    maxChars: 900,
    keepTailChars: 140,
    summarize: async (text) => {
      summarizedText = text;
      return [
        'Concrete fact: robotics market is the reference domain.',
        'Decision: ship U9 compaction before adding new tools.',
        'Credential noted: API_TOKEN=sk-secretsecretsecret123456',
      ].join('\n');
    },
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(result.history.slice(0, 2), head);
  assert.deepEqual(result.history.slice(-2), tail);
  assert.equal(result.history.at(-2).content, tail[0].content);
  assert.equal(result.history.at(-1).content, tail[1].content);

  assert.equal(result.summaryEntry.role, 'system');
  assert.ok(result.summaryEntry.content.startsWith(SUMMARY_PREFIX));
  assert.ok(result.summaryEntry.content.includes(lastRequest));
  assert.ok(result.summaryEntry.content.includes('- Decision: ship U9 compaction before adding new tools.'));
  assert.match(result.summaryEntry.content, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(result.summaryEntry.content, /sk-secretsecretsecret/);
  assert.ok(renderForTest(result.history).length <= 900);

  assert.ok(summarizedText.includes('middle filler'));
  assert.ok(summarizedText.includes(lastRequest));
  assert.ok(!summarizedText.includes(tail[0].content));
  assert.ok(!summarizedText.includes(tail[1].content));
});

test('summary failure falls back to hard middle truncation with marker', async () => {
  const { history, head, tail } = longHistoryFixture();

  const result = await compactHistory({
    history,
    maxChars: 500,
    keepTailChars: 140,
    summarize: async () => {
      throw new Error('sovereign summary unavailable');
    },
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summaryEntry.content, OMITTED_MARKER);
  assert.deepEqual(result.history.slice(0, 2), head);
  assert.ok(result.history.some((entry) => entry.role === 'system' && entry.content === OMITTED_MARKER));
  assert.deepEqual(result.history.slice(-2), tail);
  assert.ok(renderForTest(result.history).length <= 500);
});

test('compaction is deterministic with a fake summarizer', async () => {
  const { history } = longHistoryFixture();
  const input = {
    history,
    maxChars: 900,
    keepTailChars: 140,
    summarize: () => '- Decision: deterministic fake summary.',
  };

  const first = await compactHistory(input);
  const second = await compactHistory(input);

  assert.deepEqual(second.history, first.history);
  assert.deepEqual(second.summaryEntry, first.summaryEntry);
});

test('runAgentTurn compacts long history before rendering into the model prompt', async () => {
  let summarizedText = '';
  let seenUser = '';
  const history = [
    { role: 'user', content: 'First turn must remain protected.' },
    { role: 'assistant', content: 'Protected acknowledgement.' },
    { role: 'user', content: 'Concrete fact: U9 owns context compaction.' },
    { role: 'assistant', content: `middle filler ${'context '.repeat(120)}` },
    { role: 'user', content: 'LAST_UNFULFILLED_REQUEST: keep the daily thread coherent.' },
    { role: 'user', content: 'TAIL_USER_LIVE_EXACT remains verbatim.' },
    { role: 'assistant', content: 'TAIL_ASSISTANT_LIVE_EXACT remains verbatim.' },
  ];

  const result = await runAgentTurn(
    {
      userMessage: 'Current ask?',
      history,
      historyMaxChars: 650,
      historyKeepTailChars: 140,
      sovereignFloor: true,
    },
    {
      historySummarize: async (text) => {
        summarizedText = text;
        return '- Decision: preserve U9 context.';
      },
      frontierModelCall: async () => {
        throw new Error('frontier must not run');
      },
      sovereignModelCall: async ({ user }) => {
        seenUser = user;
        return 'ok';
      },
    },
  );

  assert.equal(result.content, 'ok');
  assert.ok(seenUser.includes('founder: First turn must remain protected.'));
  assert.ok(seenUser.includes('system: [earlier conversation summary]'));
  assert.ok(seenUser.includes('- Decision: preserve U9 context.'));
  assert.ok(seenUser.includes('TAIL_USER_LIVE_EXACT remains verbatim.'));
  assert.ok(seenUser.includes('TAIL_ASSISTANT_LIVE_EXACT remains verbatim.'));
  assert.ok(seenUser.endsWith('founder: Current ask?'));
  assert.ok(summarizedText.includes('middle filler'));
  assert.ok(!summarizedText.includes('TAIL_USER_LIVE_EXACT'));
});

test('history summary helper uses the sovereign single-call request shape', async () => {
  let request;
  const output = await summarizeHistoryWithSovereign(
    'founder: private middle chat',
    {
      singleCall: async (input) => {
        request = input;
        return { summary: '- summarized privately' };
      },
    },
  );

  assert.equal(output, '- summarized privately');
  assert.equal(request.label, 'cs-k:history-compaction');
  assert.equal(request.model, 'sovereign');
  assert.ok(request.system.includes('private founder chat'));
  assert.ok(request.user.includes('founder: private middle chat'));
});

test('chat route passes the module history budget to the agent turn', async () => {
  const response = mockResponse();
  let captured;

  await handleChatStream(mockRequest({ message: 'hello', history: [] }), response, {
    runTurn: async (input) => {
      captured = input;
      return { content: 'ok', lane: 'sovereign', sensitivity: 'sensitive', sovereign: true, steps: 0, held: [] };
    },
  });

  assert.equal(captured.historyMaxChars, CHAT_HISTORY_MAX_CHARS);
  assert.equal(response.events().find((event) => event.event === 'done').data.ok, true);
});

function longHistoryFixture() {
  const head = [
    { role: 'user', content: 'Start this daily session.' },
    { role: 'assistant', content: 'Session opened.' },
  ];
  const lastRequest = 'LAST_UNFULFILLED_REQUEST: compare Atlas and Hermes tomorrow before the standup.';
  const tail = [
    { role: 'user', content: 'TAIL_USER_EXACT byte content stays live.' },
    { role: 'assistant', content: 'TAIL_ASSISTANT_EXACT byte content stays live.' },
  ];

  return {
    head,
    tail,
    lastRequest,
    history: [
      ...head,
      { role: 'user', content: 'Concrete fact: robotics market is the reference domain.' },
      { role: 'assistant', content: `middle filler ${'context '.repeat(140)}` },
      { role: 'user', content: lastRequest },
      ...tail,
    ],
  };
}

function renderForTest(history) {
  const labels = { user: 'founder', assistant: 'K', system: 'system' };
  return history
    .map((entry) => `${labels[entry.role]}: ${String(entry.content).trim()}`)
    .join('\n');
}

function mockRequest(payload) {
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

function mockResponse() {
  const chunks = [];
  return {
    writableEnded: false,
    writeHead() {},
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
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          return { event, data: data ? JSON.parse(data) : null };
        });
    },
  };
}
