import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_EMBEDDING_MODEL,
  OLLAMA_EMBEDDINGS_URL,
  embed,
  embedRecord,
} from './embed.mjs';

// Manual local integration check, not part of this offline suite:
// run `ollama pull nomic-embed-text`, then call `embed("probe")` without fakes.

test('embedding text yields a stable vector with an injected fake embedder', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const text = 'K notices repeated avoidance around irreversible actions.';
  const calls = [];

  const vector = await embed(text, {
    dataDir,
    cacheDir,
    embedder: async (prompt, context) => {
      calls.push({ prompt, context });
      return fakeVector(prompt, context.model);
    },
  });

  assert.deepEqual(vector, fakeVector(text, DEFAULT_EMBEDDING_MODEL));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, text);
  assert.equal(calls[0].context.model, DEFAULT_EMBEDDING_MODEL);
});

test('re-embedding the same text and model is served from the model-keyed cache', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const text = 'Repeated exposure text is embedded once.';
  let calls = 0;

  const first = await embed(text, {
    dataDir,
    cacheDir,
    embedder: async () => {
      calls += 1;
      return [0.1, 0.2, 0.3];
    },
  });
  const second = await embed(text, {
    dataDir,
    cacheDir,
    embedder: async () => {
      calls += 1;
      return [9, 9, 9];
    },
  });

  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(cacheDir), [
    `${sha256(`${DEFAULT_EMBEDDING_MODEL}\n${text}`)}.json`,
  ]);
});

test('embedding cache separates the same text across different models', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const text = 'Repeated text must not share vectors across model dimensions.';
  const calls = [];

  const first = await embed(text, {
    dataDir,
    cacheDir,
    model: 'model-a',
    embedder: async (prompt, context) => {
      calls.push({ prompt, model: context.model });
      return [1, 0];
    },
  });
  const second = await embed(text, {
    dataDir,
    cacheDir,
    model: 'model-b',
    embedder: async (prompt, context) => {
      calls.push({ prompt, model: context.model });
      return [0, 1, 0];
    },
  });

  assert.deepEqual(first, [1, 0]);
  assert.deepEqual(second, [0, 1, 0]);
  assert.deepEqual(calls.map((call) => call.model), ['model-a', 'model-b']);
  assert.equal((await fs.readdir(cacheDir)).length, 2);
});

test('cached embeddings with a mismatched payload model are ignored', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const text = 'A stale payload must not satisfy a different model.';
  const model = 'fresh-model';
  const cacheFile = path.join(cacheDir, `${sha256(`${model}\n${text}`)}.json`);
  let calls = 0;

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(
    cacheFile,
    `${JSON.stringify({
      schemaVersion: 1,
      textHash: sha256(text),
      model: 'stale-model',
      embedding: [9, 9],
    })}\n`,
  );

  const vector = await embed(text, {
    dataDir,
    cacheDir,
    model,
    embedder: async () => {
      calls += 1;
      return [2, 3, 5];
    },
  });

  assert.deepEqual(vector, [2, 3, 5]);
  assert.equal(calls, 1);
});

test('the HTTP seam is injectable and posts the Ollama embedding request shape', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const text = 'Use localhost Ollama for sovereign embeddings.';
  const requests = [];

  const vector = await embed(text, {
    dataDir,
    cacheDir,
    model: 'test-embed-model',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({ embedding: [1, 2, 3] }),
      };
    },
  });

  assert.deepEqual(vector, [1, 2, 3]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, OLLAMA_EMBEDDINGS_URL);
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'test-embed-model',
    prompt: text,
  });
});

test('embedRecord embeds Exposure statements and SelfPattern patterns', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  const prompts = [];
  const embedder = async (prompt) => {
    prompts.push(prompt);
    return [prompts.length];
  };

  assert.deepEqual(
    await embedRecord(
      {
        kind: 'Exposure',
        id: 'exp_test',
        statement: 'Mute feeds that repeatedly steal attention.',
      },
      { dataDir, cacheDir, embedder },
    ),
    [1],
  );
  assert.deepEqual(
    await embedRecord(
      {
        kind: 'SelfPattern',
        id: 'self_test',
        pattern: 'Prefers subtraction over another dashboard.',
      },
      { dataDir, cacheDir, embedder },
    ),
    [2],
  );
  assert.deepEqual(prompts, [
    'Mute feeds that repeatedly steal attention.',
    'Prefers subtraction over another dashboard.',
  ]);
});

test('a fake embedder makes no real network call', async () => {
  const { dataDir, cacheDir } = await freshCacheDir();
  let fetchCalls = 0;

  const vector = await embed('offline fake only', {
    dataDir,
    cacheDir,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network must not be touched');
    },
    embedder: async () => [7, 8, 9],
  });

  assert.deepEqual(vector, [7, 8, 9]);
  assert.equal(fetchCalls, 0);
});

test('embedding cacheDir must stay under dataDir', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-embed-data-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-embed-outside-'));

  await assert.rejects(
    embed('cache escape attempt', {
      dataDir,
      cacheDir: outsideDir,
      embedder: async () => [1],
    }),
    /refused unsafe data path/,
  );
});

async function freshCacheDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-embed-data-'));
  return {
    dataDir,
    cacheDir: path.join(dataDir, 'embeddings'),
  };
}

function fakeVector(text, model) {
  return [text.length / 100, model.length / 100];
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
