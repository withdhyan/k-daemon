import {
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { StreamingThinkScrubber, stripThinkBlocks } from '../agent/think-scrubber.mjs';
import { deterministicToolCallId } from '../agent/tool-repair.mjs';
import {
  promptTokenEstimate,
  recordModelMetric,
} from '../metrics/instrument.mjs';

export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Sovereign default: GLM-5.1 (MIT open weights) on the ZDR lane — researched
// pick 2026-07-02 (docs/research/2026-07-02-sovereign-lane-model-selection.md):
// ZDR on 3 providers (Fireworks/Parasail US-jurisdiction), frontier agentic
// tier, fits M5-class local at Q4 — the local-endgame path. The request pins
// provider: { data_collection: 'deny', zdr: true } — hard-enforced at request
// time, so a non-ZDR provider can never serve this lane. Override via
// K_MIND_MODEL (any change requires its own research pass — founder rule).
export const DEFAULT_OPENROUTER_ZDR_MODEL = 'z-ai/glm-5.1';

const DEFAULT_OPENROUTER_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_OPENROUTER_RETRY_COUNT = 2;
const DEFAULT_OPENROUTER_RETRY_BACKOFF_MS = 250;
const DEFAULT_OPENROUTER_RETRY_JITTER_MS = 100;
// Conversation atom extraction emits a JSON array of atoms; 1024 truncated the
// output mid-JSON on rich conversations ("Unexpected end of JSON input").
// Lifted to a generous default, overridable via K_MIND_MAX_TOKENS.
const DEFAULT_MAX_TOKENS = Number(process.env.K_MIND_MAX_TOKENS) > 0
  ? Math.floor(Number(process.env.K_MIND_MAX_TOKENS))
  : 4096;

export async function openRouterZdrModelCall(request, opts = {}) {
  // Founder-directed interim (2026-07-05): while OpenRouter credits are out
  // (402), K_SOVEREIGN_PROVIDER=claude-cli routes the sovereign lane through
  // the founder's Claude subscription. Named temporary exception to the ZDR
  // floor; revert by removing the env var. See src/reason/claude-cli-model.mjs.
  // fetchImpl is the test seam: an injected stub means the caller wants the
  // OpenRouter HTTP path exactly as written — the interim provider must never
  // reroute hermetic tests (bit live 2026-07-05: 17 gate failures in lanes
  // whose env carried the flag).
  if (!opts.fetchImpl && (process.env.K_SOVEREIGN_PROVIDER ?? '').trim() === 'claude-cli') {
    const { claudeCliModelCall } = await import('./claude-cli-model.mjs');
    return claudeCliModelCall(request, opts);
  }
  const startedAt = Date.now();
  let result;
  let usage;
  let model = 'unknown';
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is unavailable for OpenRouter ZDR model call');
  }

  const apiKey = requiredString(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY');
  model = openRouterZdrModelName(request?.model ?? opts.model);
  const messages = normalizeMessages(request);
  const tools = normalizeTools(request?.tools ?? opts.tools);
  const hasTools = tools.length > 0;
  const toolChoice = request?.tool_choice ?? request?.toolChoice ?? opts.tool_choice ?? opts.toolChoice;
  const maxTokens = positiveInteger(
    request?.max_tokens ?? request?.maxTokens ?? opts.max_tokens ?? opts.maxTokens,
    DEFAULT_MAX_TOKENS,
  );
  const stallTimeoutMs = normalizeTimeoutMs(
    request?.stallTimeoutMs ?? opts.stallTimeoutMs,
    DEFAULT_STREAM_STALL_TIMEOUT_MS,
  );
  const onToken = typeof request?.onToken === 'function'
    ? request.onToken
    : opts.onToken;
  const abortScope = createAbortScope({
    timeoutMs: opts.timeoutMs,
    label: 'OpenRouter ZDR model call',
    signal: request?.signal ?? opts.signal,
  });

  try {
    abortScope.throwIfAborted();
    // Reasoning is OFF by default: GLM-5.1 is a reasoning model that otherwise
    // spends ~30s + its whole token budget on <think> before the first token —
    // the cause of interactive-chat timeouts AND empty-content failures. Callers
    // that genuinely need chain-of-thought (deliberation) pass reasoning:true.
    const reasoningEnabled = request?.reasoning === true || opts.reasoning === true;
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      provider: { data_collection: 'deny', zdr: true },
      reasoning: { enabled: reasoningEnabled },
      stream: true,
      ...(hasTools ? { tools } : {}),
      ...(hasTools && toolChoice ? { tool_choice: toolChoice } : {}),
    };

    const retryCount = nonNegativeInteger(opts.retryCount ?? opts.retries, DEFAULT_OPENROUTER_RETRY_COUNT);
    let response;
    for (let attempt = 0; ; attempt += 1) {
      response = await abortScope.race(Promise.resolve().then(() => fetchFn(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: abortScope.signal,
        body: JSON.stringify(body),
      })));

      if (response?.ok) break;

      const statusCode = Number(response?.status);
      if (!isRetryableOpenRouterStatus(statusCode) || attempt >= retryCount) {
        // Sensitive lane: log status ONLY — never interpolate the upstream response
        // body, which can echo prompt fragments (founder's private chat) into logs.
        const status = response?.status ? ` ${response.status}` : '';
        throw new Error(`OpenRouter ZDR model call failed${status}`);
      }

      await waitForOpenRouterRetry({ attempt, statusCode, opts, abortScope });
    }

    if (response.body) {
      result = await readOpenRouterStream(response.body, {
        onToken,
        abortScope,
        hasTools,
        stallTimeoutMs,
      });
      return result;
    }

    const payload = await abortScope.race(Promise.resolve().then(() => response.json()));
    usage = payload?.usage;
    result = normalizeAssistantMessage(payload?.choices?.[0]?.message, hasTools);
    if (hasTools) {
      if (typeof onToken === 'function' && result.content && result.toolCalls.length === 0) {
        onToken(result.content);
      }
      return result;
    }

    const text = requiredString(result.content, 'OpenRouter ZDR assistant message content');
    if (typeof onToken === 'function') onToken(text);
    result = text;
    return text;
  } finally {
    recordModelMetric({
      seam: 'openRouterZdrModelCall',
      lane: 'sovereign',
      model,
      ms: Date.now() - startedAt,
      promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? promptTokenEstimate(request),
      completionTokens: usage?.completion_tokens ?? usage?.output_tokens,
      result,
    });
    abortScope.cleanup();
  }
}

export function openRouterZdrModelName(value) {
  return requiredString(
    value ?? process.env.K_MIND_MODEL ?? DEFAULT_OPENROUTER_ZDR_MODEL,
    'OpenRouter ZDR model',
  );
}

function createAbortScope({ timeoutMs, label, signal }) {
  const controller = new AbortController();
  const timeout = normalizeTimeoutMs(timeoutMs, DEFAULT_OPENROUTER_TIMEOUT_MS);
  let timeoutId;
  let stallTimeoutId;
  let stallTimeout = 0;
  let timedOut = false;
  let stalled = false;

  const abortError = () =>
    new Error(
      stalled
        ? `${label} stalled after ${stallTimeout}ms`
        : timedOut
          ? `${label} timed out after ${timeout}ms`
          : `${label} aborted`,
    );
  const onExternalAbort = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else if (typeof signal?.addEventListener === 'function') {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      clearTimeout(stallTimeoutId);
      if (typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', onExternalAbort);
      }
    },
    startStall(ms) {
      stallTimeout = normalizeTimeoutMs(ms, DEFAULT_STREAM_STALL_TIMEOUT_MS);
      this.markProgress();
    },
    markProgress() {
      if (!stallTimeout || controller.signal.aborted) return;
      clearTimeout(stallTimeoutId);
      stallTimeoutId = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallTimeout);
      if (typeof stallTimeoutId.unref === 'function') stallTimeoutId.unref();
    },
    clearStall() {
      clearTimeout(stallTimeoutId);
      stallTimeoutId = undefined;
      stallTimeout = 0;
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw abortError();
    },
    race(promise) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        if (controller.signal.aborted) {
          reject(abortError());
          return;
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => {
          controller.signal.removeEventListener('abort', onAbort);
        });
      });
    },
  };
}

async function readOpenRouterStream(body, { onToken, abortScope, hasTools, stallTimeoutMs }) {
  let content = '';
  let buffer = '';
  let explicitReasoning = '';
  let displaySuppressed = false;
  const decoder = new TextDecoder();
  const scrubber = new StreamingThinkScrubber();
  const toolCalls = new Map();

  abortScope.startStall(stallTimeoutMs);
  try {
    for await (const chunk of bodyChunks(body, abortScope)) {
      abortScope.markProgress();
      abortScope.throwIfAborted();
      buffer += decodeChunk(decoder, chunk);
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseOpenRouterStreamEvent(rawEvent);
        if (event) {
          if (event.toolCallDeltas.length > 0) {
            displaySuppressed = true;
            accumulateToolCallDeltas(toolCalls, event.toolCallDeltas);
          }
          explicitReasoning += event.reasoning;
          const visible = scrubber.feed(event.content);
          content += visible;
          if (!displaySuppressed && typeof onToken === 'function' && visible) onToken(visible);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    abortScope.clearStall();
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseOpenRouterStreamEvent(buffer);
    if (event) {
      if (event.toolCallDeltas.length > 0) {
        displaySuppressed = true;
        accumulateToolCallDeltas(toolCalls, event.toolCallDeltas);
      }
      explicitReasoning += event.reasoning;
      const visible = scrubber.feed(event.content);
      content += visible;
      if (!displaySuppressed && typeof onToken === 'function' && visible) onToken(visible);
    }
  }

  const flushed = scrubber.flush();
  content += flushed;
  if (!displaySuppressed && typeof onToken === 'function' && flushed) onToken(flushed);

  const result = freezeModelResult({
    content,
    reasoning: joinReasoning(explicitReasoning, scrubber.reasoning),
    toolCalls: finalizedToolCalls(toolCalls),
  });
  return hasTools ? result : requiredString(result.content, 'OpenRouter ZDR assistant message content');
}

async function* bodyChunks(body, abortScope) {
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const result = await abortScope.race(reader.read());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  if (typeof body?.[Symbol.asyncIterator] !== 'function') {
    throw new Error('OpenRouter ZDR stream body is unavailable');
  }

  const iterator = body[Symbol.asyncIterator]();
  while (true) {
    const result = await abortScope.race(iterator.next());
    if (result.done) return;
    yield result.value;
  }
}

function decodeChunk(decoder, chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof ArrayBuffer) {
    return decoder.decode(new Uint8Array(chunk), { stream: true });
  }
  return decoder.decode(chunk, { stream: true });
}

function parseOpenRouterStreamEvent(rawEvent) {
  const data = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') return '';

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error('OpenRouter ZDR stream frame was invalid');
  }

  if (payload?.error) {
    throw new Error('OpenRouter ZDR stream failed');
  }

  const delta = payload?.choices?.[0]?.delta ?? {};
  return Object.freeze({
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: reasoningDelta(delta),
    toolCallDeltas: Array.isArray(delta.tool_calls) ? delta.tool_calls : [],
  });
}

function normalizeMessages(request) {
  if (Array.isArray(request?.messages) && request.messages.length > 0) {
    return request.messages.map(normalizeMessage);
  }

  const userContent = requiredString(request?.user ?? request?.prompt, 'OpenRouter ZDR user prompt');
  const systemContent = optionalString(request?.system) ?? '';
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

function normalizeMessage(message, index) {
  const role = requiredString(message?.role, `OpenRouter ZDR message[${index}] role`);
  const normalized = {
    role,
    content: typeof message?.content === 'string'
      ? message.content
      : message?.content === undefined || message?.content === null
        ? ''
        : String(message.content),
  };
  const toolCallId = optionalString(message?.tool_call_id);
  if (toolCallId) normalized.tool_call_id = toolCallId;
  const name = optionalString(message?.name);
  if (name) normalized.name = name;
  if (Array.isArray(message?.tool_calls)) normalized.tool_calls = message.tool_calls;
  return normalized;
}

function normalizeTools(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeAssistantMessage(message, hasTools) {
  const clean = stripThinkBlocks(typeof message?.content === 'string' ? message.content : '');
  return freezeModelResult({
    content: clean.content,
    reasoning: joinReasoning(reasoningDelta(message), clean.reasoning),
    toolCalls: hasTools ? normalizeMessageToolCalls(message?.tool_calls) : [],
  });
}

function normalizeMessageToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const functionCall = item?.function && typeof item.function === 'object' ? item.function : {};
    const name = optionalString(functionCall.name ?? item?.name) ?? '';
    const args = stringifyArguments(functionCall.arguments ?? item?.arguments);
    return Object.freeze({
      id: optionalString(item?.id) ?? deterministicToolCallId(name, args, index),
      name,
      arguments: args,
    });
  });
}

function accumulateToolCallDeltas(toolCalls, deltas) {
  for (let offset = 0; offset < deltas.length; offset += 1) {
    const delta = deltas[offset] ?? {};
    const index = Number.isInteger(delta.index) ? delta.index : offset;
    const current = toolCalls.get(index) ?? {
      index,
      id: '',
      name: '',
      arguments: '',
    };
    const functionCall = delta.function && typeof delta.function === 'object' ? delta.function : {};
    const id = optionalString(delta.id);
    if (id) current.id = id;
    const name = optionalString(functionCall.name ?? delta.name);
    if (name) current.name = name;
    if (typeof functionCall.arguments === 'string') current.arguments += functionCall.arguments;
    else if (typeof delta.arguments === 'string') current.arguments += delta.arguments;
    toolCalls.set(index, current);
  }
}

function finalizedToolCalls(toolCalls) {
  return [...toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => Object.freeze({
      id: call.id || deterministicToolCallId(call.name, call.arguments, call.index),
      name: call.name,
      arguments: call.arguments,
    }));
}

function freezeModelResult({ content, reasoning, toolCalls }) {
  return Object.freeze({
    content: typeof content === 'string' ? content : '',
    reasoning: optionalString(reasoning) ?? '',
    toolCalls: Object.freeze(Array.isArray(toolCalls) ? toolCalls : []),
  });
}

function reasoningDelta(value) {
  return optionalString(
    value?.reasoning ??
    value?.reasoning_content ??
    value?.thought ??
    value?.thinking,
  ) ?? '';
}

function joinReasoning(...parts) {
  return parts.map((part) => optionalString(part)).filter(Boolean).join('\n').trim();
}

function stringifyArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function normalizeTimeoutMs(value, fallback = DEFAULT_OPENROUTER_TIMEOUT_MS) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : fallback;
}

function isRetryableOpenRouterStatus(statusCode) {
  return statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
}

async function waitForOpenRouterRetry({ attempt, statusCode, opts, abortScope }) {
  const ms = openRouterRetryBackoffMs({ attempt, statusCode, opts });
  if (ms <= 0) return;
  await abortScope.race(delay(ms));
  abortScope.throwIfAborted();
}

function openRouterRetryBackoffMs({ attempt, statusCode, opts }) {
  if (typeof opts.retryBackoffMs === 'function') {
    return nonNegativeInteger(
      opts.retryBackoffMs({
        attempt,
        retry: attempt + 1,
        status: statusCode,
      }),
      0,
    );
  }

  const base = nonNegativeInteger(opts.retryBackoffMs, DEFAULT_OPENROUTER_RETRY_BACKOFF_MS);
  const jitter = nonNegativeInteger(opts.retryJitterMs, DEFAULT_OPENROUTER_RETRY_JITTER_MS);
  return (base * (2 ** attempt)) + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
