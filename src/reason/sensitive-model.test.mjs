import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_OPENROUTER_ZDR_MODEL,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  openRouterZdrModelCall,
} from './sensitive-model.mjs';

test('OpenRouter ZDR request denies provider data collection and sends configured auth/model', async () => {
  const requests = [];

  const text = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: 'test/zdr-model',
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      maxTokens: 321,
    }, {
      fetchImpl: captureFetch(requests, {
        choices: [{ message: { content: 'assistant text' } }],
      }),
    }));

  assert.equal(text, 'assistant text');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, OPENROUTER_CHAT_COMPLETIONS_URL);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-openrouter-key');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].body.model, 'test/zdr-model');
  assert.equal(requests[0].body.max_tokens, 321);
  assert.deepEqual(requests[0].body.provider, { data_collection: 'deny', zdr: true });
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' },
  ]);
});

test('OpenRouter ZDR streams SSE deltas to onToken and returns accumulated content', async () => {
  const requests = [];
  const tokens = [];

  const text = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: 'test/zdr-model',
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      onToken: (token) => tokens.push(token),
    }, {
      fetchImpl: captureStreamFetch(requests, [
        sse({ choices: [{ delta: { content: 'hel' } }] }),
        sse({ choices: [{ delta: { content: 'lo' } }] }),
        'data: [DONE]\n\n',
      ]),
    }));

  assert.equal(text, 'hello');
  assert.deepEqual(tokens, ['hel', 'lo']);
  assert.equal(requests[0].body.stream, true);
});

test('OpenRouter ZDR strips streamed think blocks before onToken', async () => {
  const tokens = [];

  const text = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: 'test/zdr-model',
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      onToken: (token) => tokens.push(token),
    }, {
      fetchImpl: captureStreamFetch([], [
        sse({ choices: [{ delta: { content: '<thi' } }] }),
        sse({ choices: [{ delta: { content: 'nk>private</think>visible' } }] }),
        'data: [DONE]\n\n',
      ]),
    }));

  assert.equal(text, 'visible');
  assert.deepEqual(tokens, ['visible']);
});

test('OpenRouter ZDR sends native tools and parses non-streaming message.tool_calls', async () => {
  const requests = [];

  const result = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: 'test/zdr-model',
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      tools: [{
        type: 'function',
        function: {
          name: 'memory.read',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'memory.read' },
      },
    }, {
      fetchImpl: captureFetch(requests, {
        choices: [{
          message: {
            content: '<think>private</think>visible',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'memory.read', arguments: '{"key":"a"}' },
            }],
          },
        }],
      }),
    }));

  assert.deepEqual(requests[0].body.tools, [{
    type: 'function',
    function: {
      name: 'memory.read',
      description: 'read',
      parameters: { type: 'object', properties: {} },
    },
  }]);
  assert.deepEqual(requests[0].body.tool_choice, {
    type: 'function',
    function: { name: 'memory.read' },
  });
  assert.equal(result.content, 'visible');
  assert.equal(result.reasoning, 'private');
  assert.deepEqual(result.toolCalls, [{
    id: 'call_1',
    name: 'memory.read',
    arguments: '{"key":"a"}',
  }]);
});

test('OpenRouter ZDR accumulates streaming native tool-call deltas and gates display', async () => {
  const requests = [];
  const tokens = [];

  const result = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: 'test/zdr-model',
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      tools: [{
        type: 'function',
        function: {
          name: 'substrate.read',
          description: 'read',
          parameters: { type: 'object', properties: {} },
        },
      }],
      onToken: (token) => tokens.push(token),
    }, {
      fetchImpl: captureStreamFetch(requests, [
        sse({ choices: [{ delta: { content: 'checking ' } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'memory.read', arguments: '{"que' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'substrate.read', arguments: 'ry":"x"}' } }] } }] }),
        sse({ choices: [{ delta: { content: 'hidden after call' } }] }),
        'data: [DONE]\n\n',
      ]),
    }));

  assert.deepEqual(tokens, ['checking ']);
  assert.equal(result.content, 'checking hidden after call');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'substrate.read');
  assert.equal(result.toolCalls[0].arguments, '{"query":"x"}');
  assert.match(result.toolCalls[0].id, /^call_[a-f0-9]{16}$/);
});

test('OpenRouter ZDR aborts a stalled stream when no chunk arrives', async () => {
  await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        timeoutMs: 1000,
        stallTimeoutMs: 5,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: stalledBody(),
        }),
      }),
      /OpenRouter ZDR model call stalled after 5ms/,
    );
  });
});

test('OpenRouter ZDR composes an external abort signal into the fetch signal', async () => {
  const started = deferred();
  const controller = new AbortController();
  let fetchSignal;
  let composedAbortFired = false;

  await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    const call = openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
      signal: controller.signal,
    }, {
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => {
        fetchSignal = init.signal;
        fetchSignal.addEventListener('abort', () => {
          composedAbortFired = true;
        }, { once: true });
        started.resolve();
        return await new Promise(() => {});
      },
    });

    await started.promise;
    assert.equal(fetchSignal.aborted, false);
    controller.abort();

    await assert.rejects(call, /OpenRouter ZDR model call aborted/);
  });

  assert.equal(fetchSignal.aborted, true);
  assert.equal(composedAbortFired, true);
});

test('OpenRouter ZDR returns the assistant message content from a stubbed 200', async () => {
  const text = await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: undefined,
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      prompt: 'prompt field also works',
    }, {
      fetchImpl: captureFetch([], {
        choices: [{ message: { content: 'stubbed assistant response' } }],
      }),
    }));

  assert.equal(text, 'stubbed assistant response');
});

test('OpenRouter ZDR defaults to the capable configured endpoint model', async () => {
  const requests = [];

  await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL: undefined,
  }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
    }, {
      fetchImpl: captureFetch(requests, {
        choices: [{ message: { content: 'ok' } }],
      }),
    }));

  assert.equal(requests[0].body.model, DEFAULT_OPENROUTER_ZDR_MODEL);
});

test('OpenRouter ZDR throws on missing OPENROUTER_API_KEY before any fetch', async () => {
  let calls = 0;

  await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        fetchImpl: async () => {
          calls += 1;
          throw new Error('fetch should not be called');
        },
      }),
      /OPENROUTER_API_KEY is required/,
    );
  });

  assert.equal(calls, 0);
});

test('OpenRouter ZDR throws on non-2xx and fetch errors without Anthropic fallback', async () => {
  await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        fetchImpl: async () => ({
          ok: false,
          status: 402,
          text: async () => 'top up required',
        }),
      }),
      // P3: the error carries the status but NEVER the upstream body (which can
      // echo private prompt fragments) — assert status present AND body redacted.
      (err) =>
        /OpenRouter ZDR model call failed 402/.test(err.message) &&
        !err.message.includes('top up required'),
    );

    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
      /network down/,
    );
  });

  const source = await fs.readFile(new URL('./sensitive-model.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /defaultModelCall/);
  assert.doesNotMatch(source, /@anthropic-ai\/sdk/);
  assert.doesNotMatch(source, /\bAnthropic\b/);
});

test('OpenRouter ZDR retries retryable 503 responses before succeeding', async () => {
  const requests = [];
  const backoffs = [];

  const text = await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, () =>
    openRouterZdrModelCall({
      system: 'system prompt',
      user: 'user prompt',
    }, {
      retryBackoffMs: ({ retry, status }) => {
        backoffs.push({ retry, status });
        return 0;
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        if (requests.length <= 2) {
          return {
            ok: false,
            status: 503,
            text: async () => 'SECRET founder prompt echo',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
        };
      },
    }));

  assert.equal(text, 'recovered');
  assert.equal(requests.length, 3);
  assert.deepEqual(backoffs, [{ retry: 1, status: 503 }, { retry: 2, status: 503 }]);
});

test('OpenRouter ZDR fast-fails non-retryable 400 without body echo', async () => {
  const requests = [];

  await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        retryBackoffMs: 0,
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(init.body) });
          return {
            ok: false,
            status: 400,
            text: async () => 'SECRET founder prompt echo',
          };
        },
      }),
      (error) =>
        /OpenRouter ZDR model call failed 400/.test(error.message) &&
        !error.message.includes('SECRET'),
    );
  });

  assert.equal(requests.length, 1);
});

test('OpenRouter ZDR throws when the response lacks assistant text', async () => {
  await withEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    await assert.rejects(
      openRouterZdrModelCall({
        system: 'system prompt',
        user: 'user prompt',
      }, {
        fetchImpl: captureFetch([], { choices: [{ message: {} }] }),
      }),
      /OpenRouter ZDR assistant message content is required/,
    );
  });
});

function captureFetch(requests, payload) {
  return async (url, init) => {
    requests.push({
      url: String(url),
      init,
      body: JSON.parse(init.body),
    });

    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  };
}

function captureStreamFetch(requests, chunks) {
  return async (url, init) => {
    requests.push({
      url: String(url),
      init,
      body: JSON.parse(init.body),
    });

    return {
      ok: true,
      status: 200,
      body: Readable.from(chunks),
    };
  };
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function* stalledBody() {
  await new Promise(() => {});
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
