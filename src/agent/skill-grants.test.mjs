import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStagedSkillsStore } from '../ingest/hermes-staging.mjs';
import {
  DEFAULT_TOOL_GRANTS,
  SKILL_TOOL_GRANTS,
  TOOL_GRANTS_POLICY_FILE,
  loadSkillGrants,
} from './skill-grants.mjs';
import { decideToolCall, inventoryTools } from './tools.mjs';
import { runToolLoop } from './tool-loop.mjs';
import { executeWebSearch, parseDdgResults } from './web-search.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-skill-grants-'));
  return { store: createStagedSkillsStore({ dataDir, now: fixedNow }), dataDir };
}

function ddgSkillInput() {
  return {
    skillId: 'skl-0123456789abcdef01234567',
    name: 'duckduckgo-search',
    sourcePath: 'optional-skills/research/duckduckgo-search/SKILL.md',
    contentHash: 'hash-1',
    rawBody: '---\nname: duckduckgo-search\n---\nsearch',
  };
}

test('an approved duckduckgo-search skill grants web.search and web.fetch; pending does not', async () => {
  const { store, dataDir } = await freshStore();
  const { record } = await store.stageSkill(ddgSkillInput());

  // Pending: no outward grant; default local read grant remains.
  assert.deepEqual([...(await loadSkillGrants({ dataDir, now: fixedNow }))], ['memory.search']);

  await store.setSkillStatus(record.skillId, 'approved');
  const grants = await loadSkillGrants({ dataDir, now: fixedNow });
  assert.deepEqual([...grants], ['memory.search', 'web.search', 'web.fetch']);

  // Rejection revokes the outward grant only.
  await store.setSkillStatus(record.skillId, 'rejected');
  assert.deepEqual([...(await loadSkillGrants({ dataDir, now: fixedNow }))], ['memory.search']);
});

test('no staging area at all → default local memory.search grant only', async () => {
  const dataDir = path.join(os.tmpdir(), 'cs-k-skill-grants-none', String(process.pid));
  const grants = await loadSkillGrants({ dataDir, now: fixedNow });
  assert.deepEqual([...grants], ['memory.search']);
});

test('tool grants policy can withhold the default memory.search grant', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-skill-grants-policy-'));
  const policyFile = path.join(dataDir, TOOL_GRANTS_POLICY_FILE);
  await fs.mkdir(path.dirname(policyFile), { recursive: true });
  await fs.writeFile(policyFile, `${JSON.stringify({ withheld: ['memory.search'] }, null, 2)}\n`, 'utf8');

  const grants = await loadSkillGrants({ dataDir, now: fixedNow });
  assert.equal(grants.has('memory.search'), false);
  assert.equal(decideToolCall({
    toolId: 'memory.search',
    args: { query: 'local substrate' },
    grants,
  }).action, 'hold');

  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"memory.search","arguments":{"query":"local substrate"}}</tool_call>',
    grants,
    executor: async () => {
      throw new Error('withheld memory.search must not execute');
    },
    reconsult: async () => 'done',
  });
  assert.equal(loop.executed.length, 0);
  assert.equal(loop.held.length, 1);
  assert.equal(loop.held[0].id, 'memory.search');
  assert.equal(loop.held[0].reason, 'capability_grant');
});

test('web grant tools are held without a grant and allowed with one', () => {
  for (const [toolId, args] of [
    ['web.search', { query: 'weather' }],
    ['web.fetch', { url: 'https://weather.example' }],
  ]) {
    const withoutGrant = decideToolCall({ toolId, args });
    assert.equal(withoutGrant.action, 'hold');
    assert.equal(withoutGrant.reason, 'capability_grant');

    const withGrant = decideToolCall({
      toolId,
      args,
      grants: new Set([toolId]),
    });
    assert.equal(withGrant.action, 'allow');
  }
});

test('ungranted grantable tools are not advertised in the inventory', () => {
  const base = inventoryTools(new Set());
  assert.ok(!base.some((tool) => tool.id === 'web.search'));
  assert.ok(!base.some((tool) => tool.id === 'web.fetch'));
  assert.ok(!base.some((tool) => tool.id === 'memory.search'));

  const granted = inventoryTools(new Set(['memory.search', 'web.search', 'web.fetch']));
  assert.ok(granted.some((tool) => tool.id === 'memory.search'));
  assert.ok(granted.some((tool) => tool.id === 'web.search'));
  assert.ok(granted.some((tool) => tool.id === 'web.fetch'));
  // Non-grantable tools are always present.
  assert.ok(granted.some((tool) => tool.id === 'substrate.read'));
  assert.ok(base.some((tool) => tool.id === 'substrate.read'));
});

test('every SKILL_TOOL_GRANTS target exists in the registry as grantable', () => {
  const granted = inventoryTools(new Set(Object.values(SKILL_TOOL_GRANTS).flat()));
  for (const toolId of Object.values(SKILL_TOOL_GRANTS).flat()) {
    assert.ok(granted.some((tool) => tool.id === toolId), `${toolId} missing from registry`);
  }
});

test('every DEFAULT_TOOL_GRANTS target exists in the registry as grantable', () => {
  const granted = inventoryTools(new Set(DEFAULT_TOOL_GRANTS));
  for (const toolId of DEFAULT_TOOL_GRANTS) {
    assert.ok(granted.some((tool) => tool.id === toolId), `${toolId} missing from registry`);
  }
});

const DDG_FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fweather.example%2Fchiang-mai&amp;rut=x">Chiang Mai <b>Weather</b> Forecast</a>
  <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fweather.example%2Fchiang-mai">Currently 31°C, partly cloudy with a chance of afternoon showers.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://other.example/page">Other Result</a>
  <a class="result__snippet" href="https://other.example/page">Some other snippet.</a>
</div>`;

test('parseDdgResults extracts titles, decoded urls, snippets — bounded', () => {
  const results = parseDdgResults(DDG_FIXTURE, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Chiang Mai Weather Forecast');
  assert.equal(results[0].url, 'https://weather.example/chiang-mai');
  assert.ok(results[0].snippet.includes('31°C'));
  assert.equal(parseDdgResults(DDG_FIXTURE, 1).length, 1);
});

test('executeWebSearch sends only the query and fails label-only', async () => {
  let requested;
  const okFetch = async (url) => {
    requested = url;
    return { ok: true, text: async () => DDG_FIXTURE };
  };
  const result = await executeWebSearch({ query: 'weather chiang mai' }, { fetchImpl: okFetch });
  assert.equal(result.ok, true);
  assert.ok(requested.includes('q=weather%20chiang%20mai'));
  // String output — the tool-loop contract renders strings only.
  assert.equal(typeof result.output, 'string');
  assert.ok(result.output.includes('https://weather.example/chiang-mai'));
  assert.ok(result.output.includes('31°C'));

  const failing = await executeWebSearch(
    { query: 'x' },
    { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'SECRET UPSTREAM BODY' }) },
  );
  assert.equal(failing.ok, false);
  assert.equal(failing.reason, 'search_failed_503');
  assert.ok(!JSON.stringify(failing).includes('SECRET'));

  const empty = await executeWebSearch({}, { fetchImpl: okFetch });
  assert.deepEqual(empty, { ok: false, reason: 'missing_query' });
});

test('tool turns buffer: tool syntax never streams; final text emitted once', async () => {
  const { runAgentTurn } = await import('./chat.mjs');
  const tokens = [];
  let calls = 0;

  const result = await runAgentTurn(
    {
      userMessage: 'find me the weather',
      substrateBlock: 'EXPOSURE: something',
      sovereignFloor: true,
      tools: true,
      toolGrants: new Set(['web.search']),
      onToken: (t) => tokens.push(t),
    },
    {
      sovereignModelCall: async () => {
        calls += 1;
        return calls === 1
          ? '<tool_call>{"name":"web.search","arguments":{"query":"weather chiang mai"}}</tool_call>'
          : 'It is 31°C and partly cloudy in Chiang Mai right now.';
      },
      toolExecutor: async (id, args) => {
        assert.equal(id, 'web.search');
        assert.equal(args.query, 'weather chiang mai');
        return { ok: true, output: 'web search results: 1. w — 31°C (https://x)' };
      },
    },
  );

  assert.equal(result.steps, 1);
  assert.equal(result.held.length, 0);
  assert.ok(result.content.includes('31°C'));
  // Exactly one emission, the final text — never the tool-call syntax.
  assert.deepEqual(tokens, ['It is 31°C and partly cloudy in Chiang Mai right now.']);
  assert.ok(!tokens.some((t) => t.includes('<tool_call>')));
});

test('ungranted tool call is HELD and the turn still answers', async () => {
  const { runAgentTurn } = await import('./chat.mjs');
  let calls = 0;
  const result = await runAgentTurn(
    {
      userMessage: 'find me the weather',
      substrateBlock: 'EXPOSURE: something',
      sovereignFloor: true,
      tools: true,
      toolGrants: new Set(),
      onToken: () => {},
    },
    {
      sovereignModelCall: async () => {
        calls += 1;
        return calls === 1
          ? '<tool_call>{"name":"web.search","arguments":{"query":"weather"}}</tool_call>'
          : 'unreachable';
      },
      toolExecutor: async () => {
        throw new Error('executor must not run for a held tool');
      },
    },
  );

  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].reason, 'capability_grant');
  assert.equal(result.steps, 0);
});

test('parseToolCalls accepts the bare Hermes JSON form (code-fenced, no tags)', async () => {
  const { parseToolCalls } = await import('./tools.mjs');
  const calls = parseToolCalls('Sure:\n```json\n{"name":"web.search","arguments":{"query":"weather"}}\n```');
  assert.deepEqual(calls, [{ id: 'web.search', args: { query: 'weather' } }]);
  // Unknown tool name in the bare form does not parse.
  assert.deepEqual(parseToolCalls('```json\n{"name":"rm.rf","arguments":{}}\n```'), []);
});
