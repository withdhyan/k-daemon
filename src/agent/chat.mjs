// Agent-shell chat engine for cs-k — model routing + the governed tool loop.
//
// Ported from kedar's chat-server / k-codex-consult routing pattern, rebuilt
// KTD9-native. This is the sovereign-by-construction core:
//
// - The KTD9 sensitivity gate (sensitivity.mjs) classifies the ASSEMBLED prompt
//   (SEC-001): substrate-present ⇒ SENSITIVE floor, re-run each reconsult.
// - NON-sensitive turns → the best frontier model (defaultModelCall, imported
//   from daemon/run.mjs — the single labeled Anthropic seam).
// - SENSITIVE turns → the SOVEREIGN lane (openRouterZdrModelCall, imported from
//   src/reason/sensitive-model.mjs — ZDR now, local M5). NEVER defaultModelCall.
// - SEC-002: sovereign-lane failure SILENCES. A sensitive turn whose sovereign
//   lane errors/times-out emits a hard SovereignLaneError to the caller — it
//   NEVER falls back to the frontier. `silence-default` honored.
//
// The shell wires chat + tools + routing ONLY. It does NOT inject substrate
// context (U2, gated on the mind-eval). Callers pass any assembled context in;
// this module classifies and routes it.

import {
  compactHistory,
  DEFAULT_HISTORY_MAX_CHARS,
  DEFAULT_KEEP_TAIL_CHARS,
} from './compaction.mjs';
import { classifyTurnSensitivity } from './sensitivity.mjs';
import { runSelfReview } from './self-review.mjs';
import { openRouterZdrSingleCall } from './sovereign-single-call.mjs';
import {
  extractToolCallCandidates,
  inventoryTools,
  openAiToolSchemas,
  renderToolInventory,
} from './tools.mjs';
import { runToolLoop } from './tool-loop.mjs';
import { detectGlaze, GLAZE_SURFACE_THRESHOLD } from './truth.mjs';

const DEFAULT_FRONTIER_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 2048;
export const TOOL_RECONSULT_INSTRUCTION =
  'The tool results are above. Compose the final prose answer from them now; call another tool ONLY if these results cannot answer the question. ' +
  'When composing from tool results, cite sources inline as [n] with a final "Sources:" list of the fetched/searched URLs actually used; never cite a URL not present in tool results.';

/** Hard error type for a sovereign-lane failure. Callers must SILENCE, never fall back. */
export class SovereignLaneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SovereignLaneError';
    this.sovereign = true;
    this.silence = true;
  }
}

/**
 * Run one agent chat turn.
 *
 * @param {object} input
 * @param {string} input.userMessage
 * @param {string} [input.systemPrompt] - base system prompt (shell wiring only).
 * @param {string} [input.substrateBlock] - assembled substrate context (U2; absent in the shell).
 * @param {string[]} [input.provenance] - provenance labels of merged context.
 * @param {boolean} [input.substratePresent] - explicit substrate-present signal (SEC-001 floor).
 * @param {boolean} [input.sovereignFloor] - route-level floor; true forces sovereign routing.
 * @param {number} [input.historyMaxChars] - transcript budget before compaction.
 * @param {number} [input.historyKeepTailChars] - verbatim live-tail budget.
 * @param {boolean} [input.tools] - advertise the tool inventory + run the loop.
 * @param {AbortSignal} [input.signal] - aborts the in-flight model call.
 * @param {(delta: string) => void} [input.onToken] - streaming sink.
 * @param {object} [deps] - injectable seams for tests.
 * @param {(request: object) => Promise<string>} [deps.frontierModelCall] - best-model lane.
 * @param {(request: object) => Promise<string>} [deps.sovereignModelCall] - sovereign lane.
 * @param {(id: string, args: object) => Promise<object>} [deps.toolExecutor]
 * @returns {Promise<{ content, sensitivity, sovereign, lane, steps, held, glaze? }>}
 */
export async function runAgentTurn(input = {}, deps = {}) {
  const userMessage = requireText(input.userMessage, 'userMessage');
  const compactedHistory = await compactHistoryForTurn(input, deps);
  const history = renderHistory(compactedHistory.history, {
    maxMessages: compactedHistory.compacted ? Infinity : HISTORY_MAX_MESSAGES,
    includeSystem: compactedHistory.compacted,
  });
  const toolsEnabled = input.tools === true;
  const toolGrants = input.toolGrants instanceof Set
    ? input.toolGrants
    : new Set(input.toolGrants ?? []);
  const advertisedTools = toolsEnabled
    ? inventoryTools(toolGrants, { onlyIds: input.toolIds })
    : [];
  const toolInventory = toolsEnabled ? renderToolInventory(advertisedTools) : '';
  const nativeToolSchemas = toolsEnabled ? openAiToolSchemas(advertisedTools) : [];
  const nativeSystemPrompt = assembleSystemPrompt(input, '');
  const fallbackSystemPrompt = assembleSystemPrompt(input, toolInventory);
  // Both lanes' model seams take {system, user}: the turn's user content is the
  // bounded conversation transcript (when present) + the new message.
  const userContent = history
    ? `${history}\n\nfounder: ${userMessage}`
    : userMessage;
  // SEC-001: classify the ASSEMBLED CONTEXT (base system + substrate + history
  // + user message), not the user message alone. The machine-generated tool
  // inventory is trusted, system-authored scaffolding — it legitimately names
  // substrate tools, so it is EXCLUDED from the content scan (it would
  // false-positive the backstop). The authoritative sensitivity signals are
  // `substratePresent` and `provenance`; the content scan is only a backstop
  // over untrusted context.
  const scannedContext = [
    optional(input.systemPrompt),
    optional(input.substrateBlock),
    history,
    userMessage,
  ]
    .filter(Boolean)
    .join('\n\n');
  const substratePresent =
    input.substratePresent === true || nonEmpty(input.substrateBlock);
  let classification = classifyTurnSensitivity({
    assembledPrompt: scannedContext,
    substratePresent,
    provenance: input.provenance ?? [],
  });
  classification = applySovereignFloor(classification, input.sovereignFloor === true);

  const frontierModelCall = deps.frontierModelCall ?? defaultFrontierModelCall;
  const sovereignModelCall = deps.sovereignModelCall ?? defaultSovereignModelCall;

  // Route the first turn.
  const modelCall = classification.sovereign ? sovereignModelCall : frontierModelCall;
  const lane = classification.sovereign ? 'sovereign' : 'frontier';

  const initialOutput = await invokeLane({
    modelCall,
    lane,
    system: systemForLane(lane, { nativeSystemPrompt, fallbackSystemPrompt, toolsEnabled }),
    user: userContent,
    tools: toolsForLane(lane, nativeToolSchemas),
    signal: input.signal,
    onToken: tokenSinkForLane(lane, input.onToken, toolsEnabled),
  });

  if (!toolsEnabled) {
    const result = finalize({
      content: initialOutput.content,
      classification,
      lane,
      steps: 0,
      held: [],
      logger: deps.logger,
    });
    maybeRunSelfReview(input, deps, { userContent, content: result.content });
    return result;
  }

  const executor = deps.toolExecutor ?? refuseToolExecution;

  // The reconsult closure re-routes by the per-step classification (SEC-001).
  const loop = await runToolLoop({
    initialOutput,
    sovereign: classification.sovereign,
    nativeTools: true,
    allowedToolIds: Array.isArray(input.toolIds)
      ? advertisedTools.map((tool) => tool.id)
      : undefined,
    grants: toolGrants,
    executor,
    reconsult: async ({ block, messages, sovereign }) => {
      const stepLane = sovereign ? 'sovereign' : lane;
      const stepModelCall = sovereign ? sovereignModelCall : frontierModelCall;
      const useNativeMessages = stepLane === 'sovereign' && Array.isArray(messages);
      const stepUser = `${userContent}\n\n${block}\n\n${TOOL_RECONSULT_INSTRUCTION}`;
      return invokeLane({
        modelCall: stepModelCall,
        lane: stepLane,
        system: systemForLane(stepLane, { nativeSystemPrompt, fallbackSystemPrompt, toolsEnabled }),
        user: stepUser,
        messages: useNativeMessages
          ? nativeReconsultMessages({
              system: systemForLane(stepLane, { nativeSystemPrompt, fallbackSystemPrompt, toolsEnabled }),
              user: userContent,
              toolMessages: messages,
            })
          : undefined,
        tools: toolsForLane(stepLane, nativeToolSchemas),
        signal: input.signal,
        onToken: tokenSinkForLane(stepLane, input.onToken, toolsEnabled),
      });
    },
  });

  const finalResult = loop.finalResult ?? { content: loop.finalOutput, streamed: false };
  const prose = stripToolSyntax(finalResult.content || initialOutput.content);
  // A turn whose only output was held tool calls has no prose — surface the
  // hold honestly (silence reads as integrity, never as a blank bubble).
  const finalContent = prose || heldNotice(loop.held);
  // Buffered tool turn: emit the settled answer once (tool syntax never streams).
  if (typeof input.onToken === 'function' && finalContent && finalResult.streamed !== true) {
    input.onToken(finalContent);
  }

  const result = finalize({
    content: finalContent,
    classification,
    lane: loop.sovereign ? 'sovereign' : lane,
    sovereign: loop.sovereign || classification.sovereign,
    steps: loop.steps,
    held: loop.held,
    toolResults: loop.executed,
    logger: deps.logger,
  });
  maybeRunSelfReview(input, deps, { userContent, content: result.content });
  return result;
}

// A settled tool turn can still END on a reply that embeds tool-call syntax
// (e.g. the model narrates around a held call, or emits the call JSON in a
// code fence — Hermes format variance). Strip the calls; keep the prose.
function stripToolSyntax(text) {
  const source = typeof text === 'string' ? text : '';
  return source
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*(```|$)/g, (match, body) => {
      try {
        const parsed = JSON.parse(body);
        return typeof parsed?.name === 'string' && parsed?.arguments !== undefined ? '' : match;
      } catch {
        return match;
      }
    })
    .trim();
}

export function heldNotice(held) {
  if (!Array.isArray(held) || held.length === 0) return '';
  const names = [...new Set(held.map((item) => item.id))].join(', ');
  return `I'm holding ${held.length} action${held.length === 1 ? '' : 's'} for your review (${names}).`;
}

// Bounded conversation history → a transcript block. History is founder
// content: it joins the KTD9 scanned context, and the route's sovereign floor
// keeps it off the frontier regardless.
const HISTORY_MAX_MESSAGES = 20;
const HISTORY_RENDER_MAX_CHARS = 24_000;

export function renderHistory(history, options = {}) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const maxMessages = normalizeMaxMessages(options.maxMessages);
  const entries = maxMessages === Infinity ? history : history.slice(-maxMessages);
  const lines = [];
  for (const entry of entries) {
    const role = roleLabel(entry?.role, { includeSystem: options.includeSystem === true });
    const content = optional(typeof entry?.content === 'string' ? entry.content : undefined);
    if (!role || !content) continue;
    lines.push(`${role}: ${content}`);
  }
  if (lines.length === 0) return '';
  const transcript = lines.join('\n');
  const bounded = transcript.length > HISTORY_RENDER_MAX_CHARS
    ? transcript.slice(-HISTORY_RENDER_MAX_CHARS)
    : transcript;
  return `Conversation so far:\n${bounded}`;
}

async function compactHistoryForTurn(input, deps) {
  const singleCall = deps.historySummarySingleCall ?? ((request) => openRouterZdrSingleCall(request));
  const summarize = deps.historySummarize ?? ((text) =>
    summarizeHistoryWithSovereign(text, { singleCall, signal: input.signal }));

  return compactHistory({
    history: input.history,
    maxChars: input.historyMaxChars ?? DEFAULT_HISTORY_MAX_CHARS,
    keepTailChars: input.historyKeepTailChars ?? DEFAULT_KEEP_TAIL_CHARS,
    summarize,
  });
}

export async function summarizeHistoryWithSovereign(text, { singleCall = openRouterZdrSingleCall, signal } = {}) {
  if (typeof singleCall !== 'function') throw new Error('history summary singleCall is required');
  const raw = await singleCall({
    label: 'cs-k:history-compaction',
    model: 'sovereign',
    maxTokens: 1200,
    signal,
    system: [
      'You are K compacting private founder chat for the next turn.',
      'Use only the supplied transcript.',
      'Return concise bullets preserving concrete facts, decisions, commitments, constraints, and open loops.',
      "Preserve the user's last unfulfilled request verbatim when one appears.",
      'Replace credentials, API keys, tokens, secrets, and passwords with [REDACTED].',
      'Return only the summary.',
    ].join('\n'),
    user: `Summarize the middle of this conversation for continuity.\n\n${text}`,
  });

  return modelText(raw);
}

async function invokeLane({ modelCall, lane, system, user, messages, tools, signal, onToken }) {
  try {
    throwIfAborted(signal);
    let streamed = false;
    const deferredTokens = [];
    // Stream live for tool-LESS sovereign turns (founder decision, 2026-07-03):
    // the blank-screen wait is the cost of buffering, and an already-streamed
    // partial is the founder's own sovereign content on their own device — SEC-002
    // does not require unseeing it (a mid-stream failure still silences the
    // REMAINDER and never falls back to the frontier). Tool turns STILL defer:
    // text tool-call syntax must not render mid-stream.
    const toolsActive = Array.isArray(tools) && tools.length > 0;
    const deferTokens = lane === 'sovereign' && toolsActive && typeof onToken === 'function';
    const emitToken = (text) => {
      if (deferTokens) {
        deferredTokens.push(text);
        return;
      }
      onToken(text);
    };
    const streamToken = typeof onToken === 'function'
      ? (delta) => {
          const text = typeof delta === 'string' ? delta : '';
          if (!text) return;
          streamed = true;
          emitToken(text);
        }
      : undefined;
    const raw = await modelCall({
      system,
      user,
      messages,
      tools,
      max_tokens: DEFAULT_MAX_TOKENS,
      signal,
      onToken: streamToken,
    });
    const result = normalizeModelOutput(raw);
    if (!result.content && result.toolCalls.length === 0) {
      requireText(result.content, `${lane} model output`);
    }
    if (
      !streamed &&
      typeof onToken === 'function' &&
      result.content &&
      result.toolCalls.length === 0 &&
      !hasTextToolCalls(result.content, tools)
    ) {
      streamed = true;
      emitToken(result.content);
    }
    if (deferTokens) {
      for (const token of deferredTokens) onToken(token);
    }
    return Object.freeze({ ...result, streamed });
  } catch (error) {
    if (lane === 'sovereign') {
      // SEC-002: sovereign-lane failure SILENCES. NEVER fall back to frontier.
      // Log status only — never echo the upstream body (may carry chat fragments).
      throw new SovereignLaneError('sovereign lane unavailable — turn silenced');
    }
    throw error;
  }
}

function assembleSystemPrompt(input, toolInventory) {
  const parts = [];
  const base = optional(input.systemPrompt);
  if (base) parts.push(base);
  const substrate = optional(input.substrateBlock);
  if (substrate) parts.push(substrate);
  if (toolInventory) parts.push(toolInventory);
  return parts.join('\n\n');
}

function finalize({ content, classification, lane, sovereign, steps, held, toolResults, logger = console }) {
  const glaze = detectGlaze(content);
  const surfacedGlaze = glaze.score > GLAZE_SURFACE_THRESHOLD ? glaze : null;
  if (surfacedGlaze) {
    const hitNames = surfacedGlaze.hits.map((hit) => hit.pattern).join(', ');
    logger?.warn?.(`[cs-k] glaze-check score=${surfacedGlaze.score} hits=${hitNames}`);
  }

  return Object.freeze({
    content,
    sensitivity: classification.sensitivity,
    sovereign: sovereign === true || classification.sovereign,
    lane,
    steps,
    held: Object.freeze([...held]),
    ...(Array.isArray(toolResults) && toolResults.length > 0
      ? { toolResults: Object.freeze([...toolResults]) }
      : {}),
    ...(surfacedGlaze ? { glaze: surfacedGlaze } : {}),
  });
}

function maybeRunSelfReview(input, deps, { userContent, content }) {
  if (input.selfReview !== true) return;
  const runner = deps.runSelfReview ?? runSelfReview;
  const singleCall = deps.selfReviewSingleCall ?? ((request) => openRouterZdrSingleCall(request));
  const logger = deps.logger ?? console;
  const conversationSnapshot = boundedSelfReviewSnapshot({
    system: input.systemPrompt,
    user: userContent,
    content,
  });

  Promise.resolve()
    .then(() => runner({
      conversationSnapshot,
      singleCall,
      dataDir: input.dataDir ?? deps.dataDir,
      now: input.now ?? deps.now,
      logger,
    }))
    .catch((error) => {
      logger?.warn?.(`[cs-k] self-review: ${error?.message ?? 'failed'}`);
    });
}

export function boundedSelfReviewSnapshot({ system, user, content } = {}) {
  const snapshot = [
    ['system', system],
    ['user', user],
    ['content', content],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([label, value]) => `## ${label}\n${value}`)
    .join('\n\n');
  const limit = 8 * 1024;
  return snapshot.length > limit ? snapshot.slice(-limit) : snapshot;
}

function applySovereignFloor(classification, sovereignFloor) {
  if (!sovereignFloor || classification.sovereign) return classification;
  return Object.freeze({
    ...classification,
    sensitivity: 'sensitive',
    sovereign: true,
    reason: 'sovereign_floor',
  });
}

// Default frontier lane: the single labeled Anthropic seam (daemon/run.mjs).
// Lazily imported so tests can inject a seam without loading the SDK.
async function defaultFrontierModelCall(request) {
  const { defaultModelCall } = await import('../../daemon/run.mjs');
  // defaultModelCall is tool-shaped; wrap it as a plain-text completion by
  // asking for a `reply` field. The shell's default path is test-injected;
  // production wiring names the model + tool explicitly.
  const replyTool = {
    name: 'reply',
    description: 'Return the assistant reply.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  };
  const output = await defaultModelCall({
    model: DEFAULT_FRONTIER_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    system: request.system,
    user: request.user,
    tool: replyTool,
  });
  return requireText(output?.text, 'frontier reply text');
}

// Default sovereign lane: the ZDR/local seam (src/reason/sensitive-model.mjs).
async function defaultSovereignModelCall(request) {
  const { openRouterZdrModelCall } = await import('../reason/sensitive-model.mjs');
  return openRouterZdrModelCall({
    system: request.system,
    user: request.user,
    messages: request.messages,
    tools: request.tools,
    max_tokens: request.max_tokens,
    signal: request.signal,
    onToken: request.onToken,
  });
}

// Advisory-only: the shell holds every tool call by default. A real executor is
// injected (or wired in a later unit); the shell itself never auto-runs a tool.
async function refuseToolExecution(id) {
  return Object.freeze({
    toolId: id,
    ok: false,
    held: true,
    reason: 'no_executor_wired',
  });
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('model call aborted');
}

function normalizeModelOutput(value) {
  if (typeof value === 'string') {
    return Object.freeze({ content: value, reasoning: '', toolCalls: Object.freeze([]) });
  }
  if (value && typeof value === 'object') {
    return Object.freeze({
      content: typeof value.content === 'string' ? value.content : '',
      reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
      toolCalls: Object.freeze(Array.isArray(value.toolCalls) ? value.toolCalls : []),
    });
  }
  return Object.freeze({ content: '', reasoning: '', toolCalls: Object.freeze([]) });
}

function systemForLane(lane, { nativeSystemPrompt, fallbackSystemPrompt, toolsEnabled }) {
  return toolsEnabled && lane === 'sovereign' ? nativeSystemPrompt : fallbackSystemPrompt;
}

function toolsForLane(lane, nativeToolSchemas) {
  return lane === 'sovereign' && nativeToolSchemas.length > 0 ? nativeToolSchemas : undefined;
}

function hasTextToolCalls(content, tools) {
  return Array.isArray(tools) && tools.length > 0 && extractToolCallCandidates(content).length > 0;
}

function tokenSinkForLane(lane, onToken, toolsEnabled) {
  if (typeof onToken !== 'function') return undefined;
  return toolsEnabled && lane !== 'sovereign' ? undefined : onToken;
}

function nativeReconsultMessages({ system, user, toolMessages }) {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
    ...toolMessages,
    {
      role: 'user',
      content: TOOL_RECONSULT_INSTRUCTION,
    },
  ];
}

function roleLabel(role, { includeSystem = false } = {}) {
  if (role === 'assistant') return 'K';
  if (role === 'user') return 'founder';
  if (role === 'system' && includeSystem) return 'system';
  return null;
}

function normalizeMaxMessages(value) {
  if (value === Infinity) return Infinity;
  const number = Number(value ?? HISTORY_MAX_MESSAGES);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : HISTORY_MAX_MESSAGES;
}

function modelText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return optional(value.content) || optional(value.summary) || optional(value.text) || JSON.stringify(value);
  }
  return '';
}

function optional(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export { DEFAULT_FRONTIER_MODEL };
