import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadEnvLocal } from './util/load-env.mjs';

test('loadEnvLocal reads .env.local without overriding existing env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-env-local-'));
  await fs.writeFile(
    path.join(dir, '.env.local'),
    [
      '#CS_K_ENV_LOADER_COMMENT=secret-from-comment',
      '',
      'CS_K_ENV_LOADER_EXISTING=file-value',
      'CS_K_ENV_LOADER_EQUALS=alpha=beta=gamma',
      'CS_K_ENV_LOADER_NORMAL=normal-value',
      '   # ignored indented comment',
      '',
    ].join('\n'),
    'utf8',
  );

  await withEnv({
    CS_K_ENV_LOADER_COMMENT: undefined,
    CS_K_ENV_LOADER_EQUALS: undefined,
    CS_K_ENV_LOADER_EXISTING: 'shell-value',
    CS_K_ENV_LOADER_NORMAL: undefined,
  }, async () => {
    const result = await loadEnvLocal(dir);

    assert.deepEqual(result, { loaded: true, assignedCount: 2 });
    assert.equal(process.env.CS_K_ENV_LOADER_EXISTING, 'shell-value');
    assert.equal(process.env.CS_K_ENV_LOADER_EQUALS, 'alpha=beta=gamma');
    assert.equal(process.env.CS_K_ENV_LOADER_NORMAL, 'normal-value');
    assert.equal(process.env.CS_K_ENV_LOADER_COMMENT, undefined);
  });
});

test('loadEnvLocal is a no-op when .env.local is absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-env-local-'));

  await withEnv({ CS_K_ENV_LOADER_ABSENT: undefined }, async () => {
    const result = await loadEnvLocal(dir);

    assert.deepEqual(result, { loaded: false, assignedCount: 0 });
    assert.equal(process.env.CS_K_ENV_LOADER_ABSENT, undefined);
  });
});

test('loadEnvLocal is idempotent because existing env wins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-env-local-'));
  await fs.writeFile(
    path.join(dir, '.env.local'),
    'CS_K_ENV_LOADER_IDEMPOTENT=file-value\n',
    'utf8',
  );

  await withEnv({ CS_K_ENV_LOADER_IDEMPOTENT: undefined }, async () => {
    const first = await loadEnvLocal(dir);
    const second = await loadEnvLocal(dir);

    assert.deepEqual(first, { loaded: true, assignedCount: 1 });
    assert.deepEqual(second, { loaded: true, assignedCount: 0 });
    assert.equal(process.env.CS_K_ENV_LOADER_IDEMPOTENT, 'file-value');
  });
});

async function withEnv(values, operation) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, {
      had: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(values[key]);
    }
  }

  try {
    return await operation();
  } finally {
    for (const [key, state] of previous) {
      if (state.had) {
        process.env[key] = state.value;
      } else {
        delete process.env[key];
      }
    }
  }
}
