import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  CHATBOT_INGEST_DIR,
  chatgptAdapter,
  claudeAiAdapter,
  ingestChatbot,
} from './chatbot.mjs';

const fixedNow = () => new Date('2026-06-28T00:00:00.000Z');

const CLAUDE_FIXTURE = [
  {
    uuid: 'claude-conversation-1',
    name: 'Attention strategy',
    chat_messages: [
      {
        uuid: 'claude-message-1',
        sender: 'human',
        text: 'I keep over-indexing on dashboards.',
        created_at: '2026-06-20T10:00:00.000Z',
      },
      {
        uuid: 'claude-message-2',
        sender: 'assistant',
        text: 'Prefer one subtraction before adding another metric.',
        created_at: '2026-06-20T10:01:00.000Z',
      },
    ],
  },
];

const CHATGPT_FIXTURE = [
  {
    id: 'chatgpt-conversation-1',
    title: 'Quiet workflow',
    mapping: {
      root: {
        message: null,
        parent: null,
        children: ['system-node'],
      },
      'system-node': {
        message: {
          author: { role: 'system' },
          content: { parts: ['You are ChatGPT.'] },
          create_time: 1782132000,
        },
        parent: 'root',
        children: ['user-1'],
      },
      'user-1': {
        message: {
          author: { role: 'user' },
          content: { parts: ['Make K quieter.', 'No nagging.'] },
          create_time: 1782132060,
        },
        parent: 'system-node',
        children: ['assistant-1'],
      },
      'assistant-1': {
        message: {
          author: { role: 'assistant' },
          content: { parts: ['Default to silence unless action is earned.'] },
          create_time: 1782132120,
        },
        parent: 'user-1',
        children: ['empty-user'],
      },
      'empty-user': {
        message: {
          author: { role: 'user' },
          content: { parts: ['   '] },
          create_time: 1782132180,
        },
        parent: 'assistant-1',
        children: ['user-2'],
      },
      'user-2': {
        message: {
          author: { role: 'user' },
          content: { parts: ['Thread this with the palantir context.'] },
          create_time: 1782132240,
        },
        parent: 'empty-user',
        children: [],
      },
    },
  },
];

test('Claude.ai conversations map one Exposure input per human and assistant turn', async (t) => {
  const store = await freshStore();
  const records = claudeAiAdapter(CLAUDE_FIXTURE);
  const result = await ingestChatbot({
    claudePath: await writeJsonFile(t, CLAUDE_FIXTURE),
    chatgptPath: await missingJsonFile(t),
    store,
  });

  assert.deepEqual(
    records.map((record) => record.statement),
    [
      'I keep over-indexing on dashboards.',
      'Prefer one subtraction before adding another metric.',
    ],
  );
  assert.deepEqual(records.map((record) => record.provenance.surface), [
    'claude',
    'claude',
  ]);
  assert.deepEqual(records.map((record) => record.metadata.human), [true, false]);
  assert.deepEqual(records.map((record) => record.metadata.role), [
    'human',
    'assistant',
  ]);
  assert(records.every((record) => record.metadata.conversationId === 'claude-conversation-1'));
  assert.equal(result.createdCount, 2);
  assert.equal(result.exposures[0].metadata.human, true);
  assert.equal(result.exposures[0].metadata.conversationId, 'claude-conversation-1');
  assert.equal(result.exposures[0].provenance.surface, 'claude');
});

test('ChatGPT mapping graph maps ordered user and assistant turns and skips system or empty nodes', () => {
  const records = chatgptAdapter(CHATGPT_FIXTURE);

  assert.deepEqual(
    records.map((record) => record.statement),
    [
      'Make K quieter.\n\nNo nagging.',
      'Default to silence unless action is earned.',
      'Thread this with the palantir context.',
    ],
  );
  assert.deepEqual(records.map((record) => record.provenance.surface), [
    'chatgpt',
    'chatgpt',
    'chatgpt',
  ]);
  assert.deepEqual(records.map((record) => record.metadata.human), [
    true,
    false,
    true,
  ]);
  assert.deepEqual(records.map((record) => record.metadata.originalRole), [
    'user',
    'assistant',
    'user',
  ]);
  assert.deepEqual(records.map((record) => record.metadata.turnIndex), [0, 1, 2]);
  assert(records.every((record) => record.metadata.conversationId === 'chatgpt-conversation-1'));
});

test('ChatGPT deep linear mapping ingests without recursive stack overflow', async (t) => {
  const store = await freshStore();
  const result = await ingestChatbot({
    claudePath: await missingJsonFile(t),
    chatgptPath: await writeJsonFile(t, deepChatGptFixture(6500)),
    store,
  });

  assert.equal(result.createdCount, 1);
  assert.deepEqual(
    result.exposures.map((exposure) => exposure.statement),
    ['Reached the deep leaf.'],
  );
  assert.equal(await store.countRecords('Exposure'), 1);
});

test('ChatGPT adapter skips a throwing conversation and keeps the rest of the batch', () => {
  const warnings = [];
  const originalWarn = console.warn;
  const badConversation = {};
  Object.defineProperty(badConversation, 'mapping', {
    get() {
      throw new Error('corrupt mapping');
    },
  });

  try {
    console.warn = (message) => warnings.push(String(message));
    const records = chatgptAdapter([badConversation, CHATGPT_FIXTURE[0]]);

    assert.deepEqual(
      records.map((record) => record.statement),
      [
        'Make K quieter.\n\nNo nagging.',
        'Default to silence unless action is earned.',
        'Thread this with the palantir context.',
      ],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skipped chatgpt conversation chatgpt-conversation-0: corrupt mapping/);
  } finally {
    console.warn = originalWarn;
  }
});

test('chatbot ingest refuses export paths outside the repo data root', async (t) => {
  const store = await freshStore();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-chatbot-outside-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const outsidePath = path.join(dataDir, 'conversations.json');
  await fs.writeFile(outsidePath, '[]\n', 'utf8');

  await assert.rejects(
    ingestChatbot({
      claudePath: outsidePath,
      chatgptPath: await missingJsonFile(t),
      store,
    }),
    /refused unsafe data path/,
  );
});

test('chatbot ingest is idempotent across Claude.ai and ChatGPT exports', async (t) => {
  const store = await freshStore();
  const claudePath = await writeJsonFile(t, CLAUDE_FIXTURE);
  const chatgptPath = await writeJsonFile(t, CHATGPT_FIXTURE);

  const first = await ingestChatbot({ claudePath, chatgptPath, store });
  const second = await ingestChatbot({ claudePath, chatgptPath, store });

  assert.equal(first.createdCount, 5);
  assert.equal(first.duplicateCount, 0);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 5);
  assert.equal(second.exposures.length, 5);
  assert.equal(await store.countRecords('Exposure'), 5);
});

test('missing chatbot export files are skipped gracefully', async (t) => {
  const store = await freshStore();
  const result = await ingestChatbot({
    claudePath: await missingJsonFile(t),
    chatgptPath: await missingJsonFile(t),
    store,
  });

  assert.equal(result.createdCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.exposures, []);
  assert.equal(await store.countRecords('Exposure'), 0);
});

test('malformed or empty chatbot conversations are skipped without aborting the batch', async (t) => {
  const store = await freshStore();
  const malformedClaude = [
    null,
    { uuid: 'empty-claude', chat_messages: [] },
    {
      uuid: 'bad-claude',
      chat_messages: [
        { sender: 'human', text: 'No timestamp.', created_at: null },
        {
          sender: 'alien',
          text: 'Alien sender is skipped.',
          created_at: '2026-06-20T10:00:00.000Z',
        },
      ],
    },
    {
      uuid: 'good-claude',
      chat_messages: [
        {
          sender: 'human',
          text: 'Keep the valid turn.',
          created_at: '2026-06-20T10:02:00.000Z',
        },
      ],
    },
  ];
  const malformedChatgpt = [
    { id: 'no-mapping' },
    {
      id: 'empty-chatgpt',
      mapping: {
        root: { message: null, parent: null, children: [] },
      },
    },
    {
      id: 'good-chatgpt',
      mapping: {
        root: { message: null, parent: null, children: ['user-1'] },
        'user-1': {
          message: {
            author: { role: 'user' },
            content: { parts: ['Keep this ChatGPT turn.'] },
            create_time: 1782132300,
          },
          parent: 'root',
          children: [],
        },
      },
    },
  ];

  const result = await ingestChatbot({
    claudePath: await writeJsonFile(t, malformedClaude),
    chatgptPath: await writeJsonFile(t, malformedChatgpt),
    store,
  });

  assert.deepEqual(
    result.exposures.map((exposure) => exposure.statement),
    ['Keep the valid turn.', 'Keep this ChatGPT turn.'],
  );
  assert.equal(result.createdCount, 2);
  assert.equal(await store.countRecords('Exposure'), 2);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-chatbot-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function writeJsonFile(t, payload) {
  const dataDir = await temporaryChatbotExportDir(t);
  const file = path.join(dataDir, 'conversations.json');
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

async function missingJsonFile(t) {
  const dataDir = await temporaryChatbotExportDir(t);
  return path.join(dataDir, 'conversations.json');
}

async function temporaryChatbotExportDir(t) {
  await fs.mkdir(CHATBOT_INGEST_DIR, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(CHATBOT_INGEST_DIR, 'test-export-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

function deepChatGptFixture(depth) {
  const mapping = {
    root: {
      message: null,
      parent: null,
      children: ['node-1'],
    },
  };

  for (let index = 1; index <= depth; index += 1) {
    const nodeId = `node-${index}`;
    const nextId = index === depth ? null : `node-${index + 1}`;
    mapping[nodeId] = {
      message: index === depth
        ? {
            author: { role: 'user' },
            content: { parts: ['Reached the deep leaf.'] },
            create_time: 1782132400,
          }
        : null,
      parent: index === 1 ? 'root' : `node-${index - 1}`,
      children: nextId ? [nextId] : [],
    };
  }

  return [
    {
      id: 'deep-chatgpt-conversation',
      title: 'Deep ChatGPT export',
      mapping,
    },
  ];
}
