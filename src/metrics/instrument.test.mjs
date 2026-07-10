import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMIT_TOOL,
  defaultModelCall,
} from '../../daemon/run.mjs';
import { localOllamaModelCall } from '../mind/think.mjs';
import { openRouterZdrModelCall } from '../reason/sensitive-model.mjs';
import { setMetricsHook } from './instrument.mjs';

test('OpenRouter ZDR seam records into injected metrics hook', async () => {
  const records = [];

  await withMetrics(records, () =>
    withEnv({ OPENROUTER_API_KEY: 'test-key' }, () =>
      openRouterZdrModelCall({
        model: 'test/zdr',
        system: 'system',
        user: 'prompt',
      }, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'assistant text' } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
        }),
      })));

  assert.equal(records.length, 1);
  assert.equal(records[0].seam, 'openRouterZdrModelCall');
  assert.equal(records[0].lane, 'sovereign');
  assert.equal(records[0].model, 'test/zdr');
  assert.equal(records[0].prompt_tok, 11);
  assert.equal(records[0].completion_tok, 7);
  assert.equal(records[0].tokens, 18);
  assert(records[0].ms >= 0);
});

test('defaultModelCall seam records into injected metrics hook', async () => {
  const records = [];
  const output = await withMetrics(records, () =>
    defaultModelCall({
      model: 'claude-test',
      maxTokens: 100,
      system: 'system',
      user: 'prompt',
      tool: COMMIT_TOOL,
    }, {
      client: {
        messages: {
          create: async () => ({
            usage: { input_tokens: 13, output_tokens: 5 },
            content: [{
              type: 'tool_use',
              name: COMMIT_TOOL.name,
              input: { summary: 'ok', verdict: 'silence' },
            }],
          }),
        },
      },
    }));

  assert.deepEqual(output, { summary: 'ok', verdict: 'silence' });
  assert.equal(records.length, 1);
  assert.equal(records[0].seam, 'defaultModelCall');
  assert.equal(records[0].lane, 'frontier');
  assert.equal(records[0].model, 'claude-test');
  assert.equal(records[0].prompt_tok, 13);
  assert.equal(records[0].completion_tok, 5);
});

test('local Ollama seam records into injected metrics hook', async () => {
  const records = [];
  const output = await withMetrics(records, () =>
    localOllamaModelCall({
      model: 'qwen-local',
      system: 'system',
      user: 'prompt',
    }, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          response: 'local answer',
          prompt_eval_count: 17,
          eval_count: 9,
          eval_duration: 450_000_000,
        }),
      }),
    }));

  assert.deepEqual(output, { response: 'local answer' });
  assert.equal(records.length, 1);
  assert.equal(records[0].seam, 'localOllamaModelCall');
  assert.equal(records[0].lane, 'local');
  assert.equal(records[0].model, 'qwen-local');
  assert.equal(records[0].prompt_tok, 17);
  assert.equal(records[0].completion_tok, 9);
  assert.equal(records[0].gen_ms, 450);
});

async function withMetrics(records, fn) {
  setMetricsHook({ record: (sample) => records.push(sample) });
  try {
    return await fn();
  } finally {
    setMetricsHook(null);
  }
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
