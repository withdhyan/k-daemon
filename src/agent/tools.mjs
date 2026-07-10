// Agent tool registry + governance for the cs-k agent shell.
//
// Ported from kedar's proven chat-agent-tools / chat-tool-loop pattern, rebuilt
// KTD9-native. This module is the pure DECLARATION + governance classification:
// it renders the tool inventory, parses tool calls (single + parallel), and
// classifies each call's gate. It does NOT execute tools (the shell wires the
// loop); arbitrary mutating tools stay `[auto]`-empty — governed, never
// auto-run. Narrow internal persistence exceptions are declared explicitly.
//
// Invariant: nothing here can emit an arbitrary `[auto]` action. Read-only tools
// may run in a parallel batch; outward and arbitrary mutating tools are HELD for
// a human gate. `strategize` and the admin triage tools are the narrow internal
// persistence exceptions: each runs only through its canonical edge, never
// through duplicated writes.

import { isPlainObject, optionalString } from '../substrate.mjs';

/** Why a tool call must pause for a human gate. Advisory-only posture. */
export const TOOL_GATE_REASONS = Object.freeze([
  'irreversible',
  'privacy_boundary',
  'external_spend',
  'capability_grant',
  'unknown_tool',
]);

const AUTONOMOUS = Object.freeze({ class: 'autonomous' });
const gated = (reason) => Object.freeze({ class: 'gated', reason });

// The shell's low-risk native tool surface is autonomous; outward and arbitrary
// mutating tools are gated. Kept intentionally small — the shell wires
// chat+tools+routing only.
export const AGENT_TOOLS = Object.freeze([
  Object.freeze({
    id: 'admin.parse_intake',
    toolset: 'admin',
    summary: 'Parse one admin ops intake into a non-committed parse-confirm payload for founder review.',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceText: { type: 'string', description: 'original intake text when available' },
        title: { type: 'string', description: 'short task label' },
        type: {
          type: 'string',
          enum: ['TimeSensitive', 'RegularQueue', 'Recurring'],
          description: 'admin item type',
        },
        effort: {
          type: 'string',
          enum: ['Quick', 'Hour', 'Hours'],
          description: 'estimated ops effort',
        },
        remindDate: {
          type: ['string', 'null'],
          description: 'reminder date as YYYY-MM-DD, or null when absent',
        },
        dueDate: {
          type: ['string', 'null'],
          description: 'hard due date as YYYY-MM-DD, or null when absent',
        },
        recurrence: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            frequency: { type: 'string' },
            interval: { type: 'number' },
            anchorDate: { type: ['string', 'null'] },
          },
          description: 'recurrence details when type is Recurring',
        },
        note: { type: 'string', description: 'bounded useful context' },
      },
      required: ['title', 'type', 'effort', 'remindDate', 'dueDate'],
    },
  }),
  Object.freeze({
    id: 'substrate.read',
    toolset: 'substrate',
    summary: 'Read bounded, frontier-safe substrate context (exposures, self-patterns, idea-atoms, recommendations).',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'optional relevance query' },
      },
    },
  }),
  Object.freeze({
    id: 'deliberate',
    toolset: 'reason',
    summary: 'Deliberate on a high-stakes question with the Board, sovereign research, dissent, and a staged advisory decision.',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
      },
      required: ['question'],
    },
  }),
  Object.freeze({
    id: 'strategize',
    toolset: 'reason',
    summary: 'Build a bounded strategy artifact for a named outcome; may persist strategy goals through the strategy edge.',
    readOnly: false,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string' },
      },
      required: ['outcome'],
    },
  }),
  Object.freeze({
    id: 'admin.add',
    toolset: 'admin',
    summary: 'Add a quarantined admin item and emit a normal admin stream entry; never schedules it onto core/middle cadence blocks.',
    readOnly: false,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['TimeSensitive', 'RegularQueue', 'Recurring'] },
        effort: { type: 'string', enum: ['Quick', 'Hour', 'Hours'] },
        remindAt: { type: 'string', description: 'ISO reminder datetime' },
        dueAt: { type: 'string', description: 'ISO due datetime' },
        note: { type: 'string' },
      },
      required: ['title'],
    },
  }),
  Object.freeze({
    id: 'admin.reschedule',
    toolset: 'admin',
    summary: 'Reschedule a quarantined admin item and emit a normal admin stream entry; cadence projection remains ops-block-only.',
    readOnly: false,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string' },
        remindAt: { type: 'string', description: 'ISO reminder datetime' },
        dueAt: { type: 'string', description: 'ISO due datetime' },
      },
      required: ['itemId'],
    },
  }),
  Object.freeze({
    id: 'admin.complete',
    toolset: 'admin',
    summary: 'Complete a quarantined admin item and emit a normal admin stream entry; no question card is raised.',
    readOnly: false,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string' },
      },
      required: ['itemId'],
    },
  }),
  Object.freeze({
    // GRANTABLE by default: read-only local substrate search. Unlike web.*
    // this has no off-machine egress; the grant exists so the same
    // grant/hold machinery can withhold it if the local grants policy says so.
    id: 'memory.search',
    toolset: 'memory',
    summary: "Search the founder's local exposure index and matching mind cards (read-only, sovereign).",
    readOnly: true,
    grantable: true,
    risk: gated('capability_grant'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'memory search query' },
        limit: { type: 'number', description: 'maximum exposure results (default 6)' },
      },
      required: ['query'],
    },
  }),
  Object.freeze({
    id: 'memory.read',
    toolset: 'memory',
    summary: 'Read persistent K memory.',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
    },
  }),
  Object.freeze({
    id: 'memory.write',
    toolset: 'memory',
    summary: 'Stage a durable fact to K memory (held for a human gate).',
    readOnly: false,
    risk: gated('irreversible'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
  }),
  Object.freeze({
    // GRANTABLE: inert until the founder approves the backing Hermes skill
    // (duckduckgo-search) via the staged-skills gate (U6). Read-only but
    // OUTWARD — the model-composed query leaves the machine (labeled egress:
    // DuckDuckGo). The founder's skill approval IS the capability grant that
    // accepts that query egress.
    id: 'web.search',
    toolset: 'web',
    summary: 'Search the live web via DuckDuckGo (read-only). The query text is sent to DuckDuckGo.',
    readOnly: true,
    grantable: true,
    risk: gated('capability_grant'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search query' },
        count: { type: 'number', description: 'max results (default 5)' },
      },
      required: ['query'],
    },
  }),
  Object.freeze({
    // GRANTABLE: same outward grant as web.search. The duckduckgo-search skill
    // approval covers result-following: fetching a searched URL to read the
    // page. SSRF checks and redirect re-checks live in web-fetch.mjs.
    id: 'web.fetch',
    toolset: 'web',
    summary: 'Fetch and extract a public http(s) web page (read-only). The requested URL is sent outward.',
    readOnly: true,
    grantable: true,
    risk: gated('capability_grant'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'public http(s) URL to fetch' },
        maxChars: { type: 'number', description: 'maximum extracted text chars (default 6000)' },
      },
      required: ['url'],
    },
  }),
]);

const BY_ID = new Map(AGENT_TOOLS.map((tool) => [tool.id, tool]));

export function agentToolRegistry() {
  return AGENT_TOOLS;
}

/**
 * The advertisable tool list for a turn: every non-grantable tool, plus
 * grantable tools whose id is in `grants`. Ungranted grantable tools are not
 * advertised at all — the model must not be tempted by capabilities the
 * founder has not approved. A GRANTED tool is advertised as autonomous (its
 * gate has been settled by the founder); decideToolCall remains the
 * authoritative gate and re-checks the grant on every call.
 */
export function inventoryTools(grants, options = {}) {
  const granted = grants instanceof Set ? grants : new Set(grants ?? []);
  const onlyIds = new Set(
    (Array.isArray(options.onlyIds) ? options.onlyIds : [])
      .map((id) => optionalString(id))
      .filter(Boolean),
  );
  return AGENT_TOOLS
    .filter((tool) => onlyIds.size === 0 || onlyIds.has(tool.id))
    .filter((tool) => tool.grantable !== true || granted.has(tool.id))
    .map((tool) =>
      tool.grantable === true && granted.has(tool.id)
        ? Object.freeze({ ...tool, risk: AUTONOMOUS })
        : tool);
}

export function getAgentTool(id) {
  const key = optionalString(id);
  return (key && BY_ID.get(key)) || null;
}

/** Read-only tools may run in a parallel batch. */
export function isReadOnlyTool(id) {
  return getAgentTool(id)?.readOnly === true;
}

/**
 * Gate a tool call. Fail-closed: an unknown tool is HELD, never run. A gated
 * (mutating/outward) tool is HELD — the shell is advisory-only, `[auto]`-empty.
 * An autonomous tool with no dependency marker is `allow` with a reason that
 * distinguishes read-only tools from narrow internal persistence tools.
 *
 * @returns {{ action: 'allow'|'hold', toolId: string, reason: string }}
 */
export function decideToolCall(input = {}) {
  const toolId = optionalString(input?.toolId) ?? '';
  const args = isPlainObject(input?.args) ? input.args : {};
  const tool = getAgentTool(toolId);
  const grants = input?.grants instanceof Set ? input.grants : new Set(input?.grants ?? []);

  if (!tool) {
    return hold(toolId, 'unknown_tool');
  }
  const granted = tool.grantable === true && grants.has(tool.id);
  if (tool.risk.class !== 'autonomous' && !granted) {
    return hold(toolId, tool.risk.reason);
  }
  if (hasToolResultDependency(args)) {
    // A call that depends on a prior tool result cannot run in the parallel
    // read-only batch; it is deferred to a subsequent serial step. The gate
    // still allows it, but the loop schedules it serially.
    return Object.freeze({ action: 'allow', toolId, reason: 'autonomous_dependent' });
  }
  return Object.freeze({
    action: 'allow',
    toolId,
    reason: tool.readOnly === true ? 'autonomous_read_only' : 'autonomous_internal',
  });
}

function hold(toolId, reason) {
  return Object.freeze({ action: 'hold', toolId, reason });
}

/**
 * Render the tool inventory as a Hermes-style <tools> system block. Advertises
 * exactly the wired tools; the model is told never to claim an unlisted tool.
 */
export function renderToolInventory(tools = AGENT_TOOLS) {
  const signatures = openAiToolSchemas(tools);

  return [
    'You may call tools. Tool signatures are provided within <tools></tools>.',
    '<tools>',
    JSON.stringify(signatures, null, 2),
    '</tools>',
    'To call, emit <tool_call>{"name":"<id>","arguments":{...}}</tool_call>.',
    'Autonomous tools run immediately; tools marked needs-review are held for a human gate — propose them, never assume them done.',
    'HARD RULES: (1) If the user asks about live/current world state (weather,',
    'news, prices, facts you cannot know), an autonomous tool can answer, and',
    'NO <tool_response> for it appears in this conversation yet, your ENTIRE',
    'reply MUST be exactly one <tool_call> — no prose; you will be re-invoked',
    'with the results. (2) Once a <tool_response> is present, compose the final',
    'prose answer from it — do not call the same tool again for the same need.',
    '(3) NEVER state live-world facts you did not receive from a tool response',
    'in this conversation — no invented weather, prices, or news, ever.',
  ].join('\n');
}

export function openAiToolSchemas(tools = AGENT_TOOLS) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.id,
      description:
        tool.summary +
        (tool.risk.class === 'autonomous' ? ' [autonomous]' : ` [needs review: ${tool.risk.reason}]`),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * Parse tool calls from a model reply: Hermes <tool_call> tags AND bare JSON
 * objects with a `toolCalls` array. Supports PARALLEL calls (multiple tags).
 * Only ids present in the registry survive.
 *
 * @returns {Array<{ id: string, args: object }>}
 */
export function parseToolCalls(modelOutput) {
  return extractToolCallCandidates(modelOutput)
    .filter((call) => getAgentTool(call.name))
    .map((call) => ({
      id: call.name,
      args: normalizeParsedArgs(call.arguments),
    }));
}

export function extractToolCallCandidates(modelOutput) {
  const source = optionalString(modelOutput) ?? '';
  const calls = [];

  for (const tagged of findTaggedToolCallCandidates(source)) {
    collectToolCallCandidates(safeParseJson(tagged), calls);
  }

  for (const candidate of findJsonObjectCandidates(source)) {
    collectToolCallCandidates(safeParseJson(candidate), calls);
  }

  return dedupeToolCallCandidates(calls);
}

/** Render a tool result as a Hermes <tool_response> block for reconsult. */
export function renderToolResponse(result) {
  const name = optionalString(result?.toolId) ?? 'tool';
  const response = { name, content: renderToolResultContent(result) };
  return `<tool_response>${JSON.stringify(response)}</tool_response>`;
}

export function renderToolResultContent(result) {
  const lines = [result?.ok ? 'ok' : 'failed'];
  if (result?.held) lines.push('held_for_human_gate');
  if (result?.reason) lines.push(`reason=${result.reason}`);
  const output = optionalString(result?.output);
  if (output) lines.push(`output: ${output.slice(0, 6000)}`);
  return lines.join('\n');
}

// --- parsing internals (ported from kedar/lib/chat-tool-loop.ts) ---

function findTaggedToolCallCandidates(source) {
  const candidates = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match = pattern.exec(source);
  while (match !== null) {
    candidates.push(match[1].trim());
    match = pattern.exec(source);
  }
  return candidates;
}

function findJsonObjectCandidates(source) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth++; continue; }
    if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function safeParseJson(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function collectToolCallCandidates(parsed, calls) {
  if (!isPlainObject(parsed)) return;

  if (Array.isArray(parsed.toolCalls)) {
    for (const item of parsed.toolCalls) collectToolCallCandidate(item, calls);
  }
  if (Array.isArray(parsed.tool_calls)) {
    for (const item of parsed.tool_calls) collectToolCallCandidate(item, calls);
  }
  if (Array.isArray(parsed.calls)) {
    for (const item of parsed.calls) collectToolCallCandidate(item, calls);
  }
  if (Array.isArray(parsed.tools)) {
    for (const item of parsed.tools) collectToolCallCandidate(item, calls);
  }

  collectToolCallCandidate(parsed.tool_call, calls);
  collectToolCallCandidate(parsed, calls);
}

function collectToolCallCandidate(item, calls) {
  if (!isPlainObject(item)) return;

  const hasFunction = isPlainObject(item.function);
  const functionCall = hasFunction ? item.function : {};
  const name =
    optionalString(functionCall.name) ??
    optionalString(item.name) ??
    optionalString(item.tool) ??
    (item.args !== undefined || item.arguments !== undefined ? optionalString(item.id) : undefined);
  if (!name && item.arguments === undefined && item.args === undefined && !hasFunction) return;

  const args = functionCall.arguments ?? item.arguments ?? item.args ?? {};
  const callId = hasFunction
    ? optionalString(item.id)
    : optionalString(item.callId ?? item.call_id);
  calls.push(Object.freeze({
    name: name ?? '',
    arguments: args,
    callId,
  }));
}

function normalizeParsedArgs(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') return {};
  const parsed = safeParseJson(value);
  return isPlainObject(parsed) ? parsed : {};
}

function dedupeToolCallCandidates(calls) {
  const seen = new Set();
  const deduped = [];
  for (const call of calls) {
    const key = JSON.stringify([
      call.name,
      call.callId ?? '',
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(call);
  }
  return deduped;
}

// A call whose args reference a prior tool result must not be batched.
function hasToolResultDependency(value) {
  if (typeof value === 'string') return hasDependencyMarker(value);
  if (Array.isArray(value)) return value.some((item) => hasToolResultDependency(item));
  if (!isPlainObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (isDependencyKey(key) && hasDependencyValue(nested)) return true;
    if (hasToolResultDependency(nested)) return true;
  }
  return false;
}

function isDependencyKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized === 'dependson' ||
    normalized === 'dependsonid' ||
    normalized === 'dependency' ||
    normalized === 'dependencies' ||
    normalized === 'sourcetool' ||
    normalized === 'fromtool' ||
    normalized === 'previousresult' ||
    normalized === 'toolresult' ||
    normalized === 'tooloutput'
  );
}

function hasDependencyValue(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function hasDependencyMarker(value) {
  return (
    /<\/?tool_response\b/i.test(value) ||
    /\btool[_ -]?(?:result|output|response)\b/i.test(value) ||
    /\bprevious[_ -]?(?:result|output|tool)\b/i.test(value)
  );
}
