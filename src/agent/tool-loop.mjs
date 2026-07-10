// Governed tool loop for the cs-k agent shell.
//
// Ported from kedar/lib/chat-tool-loop.ts, rebuilt KTD9-native:
// - MAX 4 steps (bounded).
// - Read-only tools batch in PARALLEL; dependent/serial calls run one at a time.
// - Mutating/outward tools are HELD for a human gate (advisory-only, `[auto]`-empty).
// - SEC-001: the sensitivity gate re-runs on EVERY reconsult step over the
//   assembled reconsult prompt; a step that surfaces sensitive tool output
//   (substrate) re-routes reconsult to the sovereign lane. The loop never
//   downgrades a turn that started sensitive.

import {
  decideToolCall,
  extractToolCallCandidates,
  isReadOnlyTool,
  parseToolCalls,
  renderToolResultContent,
  renderToolResponse,
} from './tools.mjs';
import { deterministicToolCallId, repairToolCall } from './tool-repair.mjs';
import { classifyTurnSensitivity } from './sensitivity.mjs';
import { isPlainObject, optionalString } from '../substrate.mjs';

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/**
 * Route one user-invoked packet action through the same governed tool loop used
 * by chat. Unknown tools fail closed as held actions; known gated tools are
 * still decided by runToolLoop/decideToolCall, and only allowed calls reach the
 * executor.
 */
export async function runGovernedToolAction(input = {}) {
  if (typeof input.executor !== 'function') {
    throw new Error('runGovernedToolAction requires an executor');
  }

  const toolId = optionalString(input.intent ?? input.toolId ?? input.id) ?? '';
  const args = isPlainObject(input.args) ? input.args : {};
  const grants = input.grants instanceof Set ? input.grants : new Set(input.grants ?? []);
  const decision = decideToolCall({ toolId, args, grants });

  if (decision.action !== 'allow' && decision.reason === 'unknown_tool') {
    return heldActionResult({
      toolId: decision.toolId,
      reason: decision.reason,
      sovereign: input.sovereign === true,
    });
  }

  return runToolLoop({
    initialOutput: {
      content: '',
      toolCalls: [{
        id: optionalString(input.callId ?? input.actionId) ??
          deterministicToolCallId(toolId, args, 0),
        name: toolId,
        arguments: JSON.stringify(args),
      }],
    },
    executor: input.executor,
    reconsult: typeof input.reconsult === 'function' ? input.reconsult : async () => '',
    sovereign: input.sovereign === true,
    nativeTools: input.nativeTools === true,
    grants,
    maxSteps: 1,
  });
}

/**
 * Run the governed tool loop.
 *
 * @param {object} input
 * @param {string} input.initialOutput - the model's first reply (may contain tool calls).
 * @param {(id: string, args: object) => Promise<object>} input.executor - runs an ALLOWED tool.
 *   Must return `{ ok, output?, reason?, sensitive?, provenance? }`.
 * @param {(reconsultContext: object) => Promise<string>} input.reconsult - re-invokes the model
 *   with the tool responses. Receives `{ block, sovereign, sensitivity }` so the caller can
 *   route reconsult to the correct lane (SEC-001/SEC-002).
 * @param {boolean} [input.sovereign] - whether the turn is already sovereign-routed.
 * @param {number} [input.maxSteps]
 * @returns {Promise<{ steps, executed, held, finalOutput, sovereign }>}
 */
export async function runToolLoop(input = {}) {
  if (typeof input.executor !== 'function') {
    throw new Error('runToolLoop requires an executor');
  }
  if (typeof input.reconsult !== 'function') {
    throw new Error('runToolLoop requires a reconsult callback');
  }

  const maxSteps = clampSteps(input.maxSteps);
  const grants = input.grants instanceof Set ? input.grants : new Set(input.grants ?? []);
  const allowedToolIds = normalizeAllowedToolIds(input.allowedToolIds);
  const executed = [];
  const held = [];
  const nativeMessages = [];
  let steps = 0;
  let repairAttempts = 0;
  let sovereign = input.sovereign === true;
  let currentOutput = normalizeModelResult(input.initialOutput);

  while (true) {
    const extracted = extractRequests(currentOutput);
    if (extracted.invalid.length > 0) {
      if (repairAttempts >= DEFAULT_MAX_REPAIR_ATTEMPTS) break;
      const repairMessages = renderToolRepairMessages(currentOutput, extracted.invalid);
      if (input.nativeTools === true) nativeMessages.push(...repairMessages.messages);
      currentOutput = normalizeModelResult(
        await input.reconsult({
          block: repairMessages.block,
          messages: input.nativeTools === true ? [...nativeMessages] : undefined,
          sovereign,
          sensitivity: 'public',
          repair: true,
        }),
      );
      repairAttempts += 1;
      continue;
    }

    const requests = extracted.requests;
    if (requests.length === 0) break;

    const scheduled = requests.map((request) => ({
      request,
      decision: allowedToolIds && !allowedToolIds.has(request.id)
        ? Object.freeze({ action: 'hold', toolId: request.id, reason: 'unknown_tool' })
        : decideToolCall({ toolId: request.id, args: request.args, grants }),
    }));

    const stepResults = [];
    const stepPairs = [];

    for (let index = 0; index < scheduled.length;) {
      const item = scheduled[index];

      if (item.decision.action !== 'allow') {
        held.push(Object.freeze({ id: item.request.id, reason: item.decision.reason }));
        index += 1;
        continue;
      }

      if (steps >= maxSteps) {
        // Bounded: stop scheduling further tool work once the step budget is spent.
        index += 1;
        continue;
      }

      const batch = collectParallelBatch(scheduled, index);
      if (batch.length > 1) {
        const results = await Promise.all(
          batch.map((entry) => runOne(entry, input.executor)),
        );
        executed.push(...results);
        stepResults.push(...results);
        for (let offset = 0; offset < batch.length; offset += 1) {
          stepPairs.push({ request: batch[offset].request, result: results[offset] });
        }
        index += batch.length;
        continue;
      }

      const result = await runOne(item, input.executor);
      executed.push(result);
      stepResults.push(result);
      stepPairs.push({ request: item.request, result });
      index += 1;
    }

    if (stepResults.length === 0) break;

    // SEC-001: re-classify on the assembled reconsult prompt every step. Any
    // sensitive tool output raises the floor and pins reconsult to the sovereign
    // lane; the turn never de-escalates below where it started.
    const block = stepResults.map(renderToolResponse).join('\n');
    const provenance = stepResults.flatMap((result) => result.provenance ?? []);
    const substratePresent = stepResults.some((result) => result.sensitive === true);
    const classification = classifyTurnSensitivity({
      assembledPrompt: block,
      substratePresent,
      provenance,
    });
    sovereign = sovereign || classification.sovereign;
    if (input.nativeTools === true) {
      nativeMessages.push(...renderNativeToolExchange(currentOutput, stepPairs));
    }

    currentOutput = normalizeModelResult(
      await input.reconsult({
        block,
        messages: input.nativeTools === true ? [...nativeMessages] : undefined,
        sovereign,
        sensitivity: classification.sensitivity,
      }),
    );
    steps += 1;

    if (steps >= maxSteps) break;
  }

  return {
    steps,
    executed,
    held,
    finalOutput: currentOutput.content,
    finalResult: currentOutput,
    sovereign,
  };
}

async function runOne(item, executor) {
  try {
    const result = await executor(item.request.id, item.request.args);
    return normalizeResult(item.request.id, result);
  } catch (error) {
    return Object.freeze({
      toolId: item.request.id,
      ok: false,
      reason: optionalText(error?.message) || 'tool_error',
    });
  }
}

function normalizeResult(toolId, result) {
  const base = result && typeof result === 'object' ? result : {};
  return Object.freeze({
    toolId,
    ok: base.ok === true,
    output: optionalText(base.output),
    reason: optionalText(base.reason),
    held: base.held === true,
    sensitive: base.sensitive === true,
    sensitivity: optionalText(base.sensitivity),
    frontierExcluded: base.frontierExcluded === true,
    provenance: Array.isArray(base.provenance) ? base.provenance : [],
    artifacts: isPlainObject(base.artifacts) ? base.artifacts : undefined,
    packets: Array.isArray(base.packets) ? base.packets : undefined,
  });
}

function heldActionResult({ toolId, reason, sovereign }) {
  return Object.freeze({
    steps: 0,
    executed: Object.freeze([]),
    held: Object.freeze([
      Object.freeze({ id: toolId, reason }),
    ]),
    finalOutput: '',
    finalResult: Object.freeze({
      content: '',
      reasoning: '',
      toolCalls: Object.freeze([]),
      streamed: false,
    }),
    sovereign: sovereign === true,
  });
}

// Contiguous run of allowed, read-only, dependency-free calls → one parallel batch.
function collectParallelBatch(scheduled, startIndex) {
  const batch = [];
  for (let index = startIndex; index < scheduled.length; index += 1) {
    const item = scheduled[index];
    if (item.decision.action !== 'allow') break;
    if (item.decision.reason === 'autonomous_dependent') break;
    if (!isReadOnlyTool(item.request.id)) break;
    batch.push(item);
  }
  return batch;
}

function clampSteps(value) {
  const number = Number(value ?? DEFAULT_MAX_STEPS);
  if (!Number.isFinite(number) || number < 0) return DEFAULT_MAX_STEPS;
  return Math.min(Math.floor(number), DEFAULT_MAX_STEPS);
}

function normalizeAllowedToolIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((id) => optionalString(id))
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : new Set();
}

function optionalText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeModelResult(value) {
  if (typeof value === 'string') {
    return Object.freeze({ content: value, toolCalls: Object.freeze([]), reasoning: '', streamed: false });
  }
  if (value && typeof value === 'object') {
    return Object.freeze({
      content: optionalText(value.content),
      reasoning: optionalText(value.reasoning),
      toolCalls: Object.freeze(Array.isArray(value.toolCalls) ? value.toolCalls : []),
      streamed: value.streamed === true,
    });
  }
  return Object.freeze({ content: '', toolCalls: Object.freeze([]), reasoning: '', streamed: false });
}

function extractRequests(modelResult) {
  const rawCalls = modelResult.toolCalls.length > 0
    ? modelResult.toolCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        callId: call.id,
      }))
    : extractToolCallCandidates(modelResult.content);
  const requests = [];
  const invalid = [];

  rawCalls.forEach((call, index) => {
    const repaired = repairToolCall(call, { index });
    if (!repaired.ok) {
      invalid.push(repaired);
      return;
    }
    requests.push(Object.freeze({
      id: repaired.id,
      args: repaired.args,
      callId: repaired.callId,
      originalName: repaired.originalName,
      rawArguments: call.arguments,
    }));
  });

  // The legacy parser stays as the fallback contract for callers that import it
  // directly and for model text the raw extractor cannot classify.
  if (rawCalls.length === 0 && modelResult.toolCalls.length === 0) {
    for (const parsed of parseToolCalls(modelResult.content)) {
      requests.push(Object.freeze({
        id: parsed.id,
        args: parsed.args,
        callId: undefined,
        originalName: parsed.id,
        rawArguments: parsed.args,
      }));
    }
  }

  return { requests, invalid };
}

function renderNativeToolExchange(modelResult, pairs) {
  if (!pairs.length) return [];
  const toolCalls = pairs.map(({ request }, index) => toNativeToolCall(request, index));
  const messages = [
    {
      role: 'assistant',
      content: modelResult.content,
      tool_calls: toolCalls,
    },
  ];
  for (const { request, result } of pairs) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId(request),
      name: request.id,
      content: renderToolResultContent(result),
    });
  }
  return messages;
}

function renderToolRepairMessages(modelResult, invalid) {
  const toolCalls = invalid.map((item, index) => ({
    id: item.callId,
    type: 'function',
    function: {
      name: item.name || 'invalid_tool_call',
      arguments: '{}',
    },
    index,
  }));
  const messages = [
    {
      role: 'assistant',
      content: modelResult.content,
      tool_calls: toolCalls,
    },
    ...invalid.map((item) => ({
      role: 'tool',
      tool_call_id: item.callId,
      name: item.name || 'invalid_tool_call',
      content: item.message,
    })),
  ];
  const block = invalid.map((item) => renderToolResponse({
    toolId: item.name || 'invalid_tool_call',
    ok: false,
    reason: item.message,
  })).join('\n');
  return { block, messages };
}

function toNativeToolCall(request, index) {
  return {
    id: toolCallId(request, index),
    type: 'function',
    function: {
      name: request.id,
      arguments: JSON.stringify(request.args ?? {}),
    },
  };
}

function toolCallId(request, index = 0) {
  return request.callId || deterministicToolCallId(request.id, request.args, index);
}

export { DEFAULT_MAX_STEPS };
