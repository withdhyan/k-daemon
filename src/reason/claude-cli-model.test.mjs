import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { claudeCliModelCall } from './claude-cli-model.mjs';

function fakeChild({ stdout = '', code = 0, stderr = '', neverExit = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: '',
    end(data) {
      this.written = data ?? '';
      queueMicrotask(() => {
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        if (!neverExit) child.emit('close', code);
      });
    },
  };
  child.kill = () => { child.killed = true; };
  return child;
}

function spawnStub(children, calls = []) {
  let index = 0;
  const impl = (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = children[Math.min(index, children.length - 1)];
    index += 1;
    return child;
  };
  return { impl, calls };
}

test('returns trimmed content for system+user request', async () => {
  const child = fakeChild({ stdout: '  the answer\n' });
  const { impl, calls } = spawnStub([child]);
  const result = await claudeCliModelCall(
    { system: 'anchor text', user: 'question?' },
    { spawnImpl: impl, env: { K_CLAUDE_CLI_PATH: '/usr/local/bin/claude' } },
  );
  assert.equal(result, 'the answer');
  assert.equal(calls[0].binary, '/usr/local/bin/claude');
  assert.ok(calls[0].args.includes('-p'));
  const sysIdx = calls[0].args.indexOf('--system-prompt');
  assert.ok(calls[0].args[sysIdx + 1].includes('anchor text'));
  assert.ok(calls[0].args[sysIdx + 1].includes('completion endpoint'));
  assert.equal(child.stdin.written, 'question?');
});

test('messages array: system parts go to system flag, turns to stdin', async () => {
  const child = fakeChild({ stdout: 'ok' });
  const { impl, calls } = spawnStub([child]);
  await claudeCliModelCall(
    {
      messages: [
        { role: 'system', content: 'sys A' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
    },
    { spawnImpl: impl, env: {} },
  );
  const sysIdx = calls[0].args.indexOf('--system-prompt');
  assert.ok(calls[0].args[sysIdx + 1].includes('sys A'));
  assert.ok(child.stdin.written.includes('[user]\nhello'));
  assert.ok(child.stdin.written.includes('[assistant]\nhi'));
});

test('tools requested: returns frozen result with empty toolCalls', async () => {
  const child = fakeChild({ stdout: 'plain reply' });
  const { impl } = spawnStub([child]);
  const result = await claudeCliModelCall(
    { user: 'q', tools: [{ type: 'function', function: { name: 'x' } }] },
    { spawnImpl: impl, env: {} },
  );
  assert.equal(result.content, 'plain reply');
  assert.deepEqual([...result.toolCalls], []);
  assert.ok(Object.isFrozen(result));
});

test('onToken fires once with the full text', async () => {
  const child = fakeChild({ stdout: 'streamed-as-one' });
  const { impl } = spawnStub([child]);
  const chunks = [];
  await claudeCliModelCall(
    { user: 'q', onToken: (t) => chunks.push(t) },
    { spawnImpl: impl, env: {} },
  );
  assert.deepEqual(chunks, ['streamed-as-one']);
});

test('non-zero exit rejects with bounded stderr', async () => {
  const child = fakeChild({ stdout: '', code: 1, stderr: 'usage limit reached' });
  const { impl } = spawnStub([child]);
  await assert.rejects(
    claudeCliModelCall({ user: 'q' }, { spawnImpl: impl, env: {} }),
    /claude-cli exited 1: usage limit reached/,
  );
});

test('empty output rejects (never a silent empty completion)', async () => {
  const child = fakeChild({ stdout: '   ' });
  const { impl } = spawnStub([child]);
  await assert.rejects(
    claudeCliModelCall({ user: 'q' }, { spawnImpl: impl, env: {} }),
    /claude-cli assistant content/,
  );
});

test('timeout kills the child and rejects', async () => {
  const child = fakeChild({ neverExit: true });
  const { impl } = spawnStub([child]);
  await assert.rejects(
    claudeCliModelCall({ user: 'q' }, { spawnImpl: impl, env: {}, timeoutMs: 20 }),
    /timed out after 20ms/,
  );
  assert.equal(child.killed, true);
});

test('ANTHROPIC_API_KEY is stripped from the child env (subscription lane)', async () => {
  const child = fakeChild({ stdout: 'ok' });
  const { impl, calls } = spawnStub([child]);
  await claudeCliModelCall(
    { user: 'q' },
    { spawnImpl: impl, env: { ANTHROPIC_API_KEY: 'sk-nope', HOME: '/Users/x' } },
  );
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].options.env.HOME, '/Users/x');
});

test('sensitive-model routes to claude-cli when K_SOVEREIGN_PROVIDER is set', async () => {
  process.env.K_SOVEREIGN_PROVIDER = 'claude-cli';
  try {
    const { openRouterZdrModelCall } = await import('./sensitive-model.mjs');
    const child = fakeChild({ stdout: 'routed' });
    const { impl } = spawnStub([child]);
    const result = await openRouterZdrModelCall(
      { system: 's', user: 'u' },
      { spawnImpl: impl },
    );
    assert.equal(result, 'routed');
  } finally {
    delete process.env.K_SOVEREIGN_PROVIDER;
  }
});

test('injected fetchImpl wins over the provider flag (hermetic test seam)', async () => {
  process.env.K_SOVEREIGN_PROVIDER = 'claude-cli';
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';
  try {
    const { openRouterZdrModelCall } = await import('./sensitive-model.mjs');
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return {
        ok: true,
        body: null,
        json: async () => ({ choices: [{ message: { content: 'via-stub' } }] }),
      };
    };
    const result = await openRouterZdrModelCall({ system: 's', user: 'u' }, { fetchImpl });
    assert.equal(fetched, true);
    assert.equal(result, 'via-stub');
  } finally {
    delete process.env.K_SOVEREIGN_PROVIDER;
  }
});
