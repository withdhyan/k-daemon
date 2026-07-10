import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../research/embed.mjs';
import {
  DEFAULT_SOUL_TEXT,
  SOUL_MAX_CHARS,
  SOUL_PROMPT_HEADER,
  loadSoulSnapshot,
  soulFilePath,
  withSoulPromptBlock,
} from './soul.mjs';

test('loadSoulSnapshot creates the soul artifact and hashes the exact identity text', async () => {
  const dataDir = await tempDataDir();

  const snapshot = await loadSoulSnapshot({ dataDir });
  const stored = (await fs.readFile(soulFilePath(dataDir), 'utf8')).trim();

  assert.equal(stored, DEFAULT_SOUL_TEXT);
  assert.equal(snapshot.text, DEFAULT_SOUL_TEXT);
  assert.equal(snapshot.contentHash, sha256(DEFAULT_SOUL_TEXT));
  assert.ok(snapshot.block.startsWith(SOUL_PROMPT_HEADER));
  assert.match(snapshot.block, /artifact: substrate\/soul\.md/);
  assert.match(snapshot.block, new RegExp(`sha256: ${snapshot.contentHash}`));
  assert.match(snapshot.block, /You are K/);
  assert(Object.isFrozen(snapshot));
});

test('loadSoulSnapshot preserves founder-edited soul text instead of reseeding', async () => {
  const dataDir = await tempDataDir();
  const text = '# K soul\n\nK stays terse and truth-first.';
  await fs.mkdir(path.dirname(soulFilePath(dataDir)), { recursive: true });
  await fs.writeFile(soulFilePath(dataDir), `${text}\n`, 'utf8');

  const snapshot = await loadSoulSnapshot({ dataDir });

  assert.equal(snapshot.text, text);
  assert.equal(snapshot.contentHash, sha256(text));
  assert.match(snapshot.block, /K stays terse and truth-first/);
});

test('soul prompt wrapper prepends the hashed soul block without dropping the task prompt', async () => {
  const snapshot = await loadSoulSnapshot({
    text: '# K soul\n\nK is silence-default.',
    createIfMissing: false,
  });

  const wrapped = withSoulPromptBlock(
    { system: 'Extract atoms only.', user: 'payload' },
    snapshot,
  );

  assert.match(wrapped.system, /## K soul document/);
  assert.match(wrapped.system, /sha256: [a-f0-9]{64}/);
  assert.match(wrapped.system, /K is silence-default/);
  assert.ok(wrapped.system.endsWith('Extract atoms only.'));
  assert.equal(wrapped.user, 'payload');
});

test('loadSoulSnapshot rejects an oversized soul artifact', async () => {
  await assert.rejects(
    () => loadSoulSnapshot({
      text: `# K soul\n\n${'x'.repeat(SOUL_MAX_CHARS)}`,
      createIfMissing: false,
    }),
    /soul document exceeds/,
  );
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-soul-'));
}
