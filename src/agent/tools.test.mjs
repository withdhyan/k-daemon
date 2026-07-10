import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentToolRegistry,
  decideToolCall,
  getAgentTool,
  inventoryTools,
  isReadOnlyTool,
  openAiToolSchemas,
  parseToolCalls,
  renderToolInventory,
  renderToolResponse,
} from './tools.mjs';

test('the tool inventory renders a spec-correct <tools> block', () => {
  const rendered = renderToolInventory();
  assert.ok(rendered.includes('<tools>'));
  assert.ok(rendered.includes('</tools>'));
  assert.ok(rendered.includes('substrate.read'));
  assert.ok(rendered.includes('[autonomous]'));
  assert.ok(rendered.includes('[needs review: irreversible]'));
});

test('OpenAI tool schemas reuse the rendered function signatures', () => {
  const schemas = openAiToolSchemas();
  const substrate = schemas.find((schema) => schema.function.name === 'substrate.read');

  assert.equal(substrate.type, 'function');
  assert.equal(substrate.function.parameters.type, 'object');
  assert.match(substrate.function.description, /\[autonomous\]/);
});

test('a read-only autonomous tool is allowed', () => {
  const decision = decideToolCall({ toolId: 'substrate.read', args: {} });
  assert.equal(decision.action, 'allow');
  assert.equal(isReadOnlyTool('substrate.read'), true);
});

test('deliberate is autonomous and non-grantable', () => {
  const tool = getAgentTool('deliberate');
  assert.equal(tool.risk.class, 'autonomous');
  assert.equal(tool.grantable, undefined);
  assert.equal(isReadOnlyTool('deliberate'), true);
  assert.equal(decideToolCall({ toolId: 'deliberate', args: { question: 'q' } }).action, 'allow');
});

test('strategize is autonomous and non-grantable', () => {
  const tool = getAgentTool('strategize');
  assert.equal(tool.risk.class, 'autonomous');
  assert.equal(tool.grantable, undefined);
  assert.equal(tool.readOnly, false);
  assert.deepEqual(tool.parameters.required, ['outcome']);
  assert.equal(decideToolCall({ toolId: 'strategize', args: { outcome: 'o' } }).action, 'allow');
});

test('admin.parse_intake is an autonomous parser for parse-confirm payloads', () => {
  const tool = getAgentTool('admin.parse_intake');
  assert.equal(tool.risk.class, 'autonomous');
  assert.equal(tool.readOnly, true);
  assert.deepEqual(tool.parameters.required, ['title', 'type', 'effort', 'remindDate', 'dueDate']);
  assert.equal(decideToolCall({
    toolId: 'admin.parse_intake',
    args: {
      title: 'renew visa',
      type: 'TimeSensitive',
      effort: 'Quick',
      remindDate: '2026-09-01',
      dueDate: '2026-09-20',
    },
  }).action, 'allow');
});

test('tool inventory can be narrowed for parser-only entry points', () => {
  assert.deepEqual(
    inventoryTools(new Set(), { onlyIds: ['admin.parse_intake'] }).map((tool) => tool.id),
    ['admin.parse_intake'],
  );
});

test('a mutating tool is HELD for a human gate (advisory-only)', () => {
  const decision = decideToolCall({ toolId: 'memory.write', args: { key: 'k', value: 'v' } });
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'irreversible');
});

test('an unknown tool is HELD (fail-closed), never run', () => {
  const decision = decideToolCall({ toolId: 'terminal.exec', args: { command: 'rm -rf /' } });
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'unknown_tool');
  assert.equal(getAgentTool('terminal.exec'), null);
});

test('a dependency-marked read-only call is allowed but flagged dependent (not batched)', () => {
  const decision = decideToolCall({
    toolId: 'substrate.read',
    args: { query: 'use ${tool_result} from before' },
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'autonomous_dependent');
});

test('parseToolCalls parses a single Hermes <tool_call> tag', () => {
  const calls = parseToolCalls('<tool_call>{"name":"substrate.read","arguments":{"query":"x"}}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'substrate.read');
  assert.deepEqual(calls[0].args, { query: 'x' });
});

test('parseToolCalls parses PARALLEL <tool_call> tags', () => {
  const output = [
    '<tool_call>{"name":"substrate.read","arguments":{}}</tool_call>',
    '<tool_call>{"name":"memory.read","arguments":{"key":"a"}}</tool_call>',
  ].join('\n');
  const calls = parseToolCalls(output);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.id), ['substrate.read', 'memory.read']);
});

test('parseToolCalls parses OpenAI-shaped text fallback tool_calls', () => {
  const calls = parseToolCalls(JSON.stringify({
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'memory.read', arguments: '{"key":"a"}' },
    }],
  }));

  assert.deepEqual(calls, [{ id: 'memory.read', args: { key: 'a' } }]);
});

test('parseToolCalls drops calls to unregistered tools', () => {
  const calls = parseToolCalls('<tool_call>{"name":"terminal.exec","arguments":{}}</tool_call>');
  assert.equal(calls.length, 0);
});

test('malformed tool-call JSON degrades safely (no throw, no calls)', () => {
  const calls = parseToolCalls('<tool_call>{not json</tool_call> and some prose');
  assert.deepEqual(calls, []);
});

test('renderToolResponse marks held tools and bounds output', () => {
  const held = renderToolResponse({ toolId: 'memory.write', held: true, ok: false });
  assert.ok(held.includes('held_for_human_gate'));
  assert.ok(held.startsWith('<tool_response>'));
});

test('the registry surface is small and read-only-first', () => {
  const ids = agentToolRegistry().map((t) => t.id);
  assert.ok(ids.includes('admin.parse_intake'));
  assert.ok(ids.includes('substrate.read'));
  assert.ok(ids.includes('deliberate'));
  assert.ok(ids.includes('strategize'));
  assert.ok(ids.includes('memory.search'));
  assert.ok(ids.includes('memory.read'));
  assert.ok(ids.includes('web.fetch'));
});
