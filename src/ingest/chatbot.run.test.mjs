import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  CHATBOT_INGEST_DIR,
  ingestChatbot,
} from './chatbot.mjs';

const fixedNow = () => new Date('2026-06-28T00:00:00.000Z');

const CLAUDE_FIXTURE = [
  {
    uuid: 'claude-run-conversation-1',
    name: 'Run wiring',
    chat_messages: [
      {
        uuid: 'claude-run-message-1',
        sender: 'human',
        text: 'Wire the existing chatbot adapter through the daemon.',
        created_at: '2026-06-20T10:00:00.000Z',
      },
    ],
  },
];

test('chatbot run wiring sees both missing exports as graceful skips', async (t) => {
  const store = await freshStore();
  const result = await ingestChatbot({
    claudePath: await missingJsonFile(t),
    chatgptPath: await missingJsonFile(t),
    store,
  });

  assert.equal(result.skipped.claude, true);
  assert.equal(result.skipped.chatgpt, true);
  assert.equal(result.createdCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.results, []);
});

test('chatbot run wiring creates exposures from a Claude export', async (t) => {
  const store = await freshStore();
  const result = await ingestChatbot({
    claudePath: await writeJsonFile(t, CLAUDE_FIXTURE),
    chatgptPath: await missingJsonFile(t),
    store,
  });

  assert.equal(result.skipped.chatgpt, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].surface, 'claude');
  assert.equal(result.createdCount, 1);
  assert.equal(await store.countRecords('Exposure'), result.createdCount);
});

test('chatbot run wiring is idempotent for the same Claude export and store', async (t) => {
  const store = await freshStore();
  const claudePath = await writeJsonFile(t, CLAUDE_FIXTURE);
  const chatgptPath = await missingJsonFile(t);

  const first = await ingestChatbot({ claudePath, chatgptPath, store });
  const second = await ingestChatbot({ claudePath, chatgptPath, store });

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, first.createdCount);
  assert.equal(await store.countRecords('Exposure'), first.createdCount);
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
