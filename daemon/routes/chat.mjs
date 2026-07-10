// Streaming chat endpoint for the cs-k agent shell.
//
// POST /api/chat — SSE token stream. Loopback/Tailscale bind only (the server's
// post-listen bind assertion enforces this; this route adds no egress). The
// route wires the agent-shell chat engine (src/agent/chat.mjs): KTD9-routed
// (sensitive → sovereign lane, SEC-001/002), governed tool loop, `[auto]`-empty.
//
// Kept in its OWN module; daemon/server.mjs adds only a small registration.

import { runAgentTurn, SovereignLaneError } from '../../src/agent/chat.mjs';
import { DEFAULT_HISTORY_MAX_CHARS } from '../../src/agent/compaction.mjs';
import { optionalString } from '../../src/substrate.mjs';
import { performance } from 'node:perf_hooks';
import { appendDiagnostic } from '../../src/agent/diagnostics.mjs';

const MAX_CHAT_BODY_BYTES = 256_000;
const DEFAULT_SSE_KEEP_ALIVE_MS = 10_000;
export const CHAT_HISTORY_MAX_CHARS = DEFAULT_HISTORY_MAX_CHARS;
export const SELF_REVIEW_NUDGE_EVERY_TURNS = 10;

let selfReviewTurnCounter = 0;

/**
 * Handle POST /api/chat as an SSE stream.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {object} ctx - injectable wiring:
 *   - runTurn?         the agent engine (defaults to runAgentTurn; overridden in tests)
 *   - baseSystemPrompt? K's persona, prepended to any caller-supplied systemPrompt
 *   - substrateBlock?  assembled frontier-safe substrate context (grounds the turn;
 *                      its presence forces KTD9 sovereign routing, SEC-001)
 *   - buildSubstrateBlock? async function(userMessage): assembles sovereign
 *                      context after this route parses the request body
 *   - deps?            the engine's model-call/tool deps
 *   - keepAliveIntervalMs? SSE comment keep-alive interval (tests may shrink it)
 */
export async function handleChatStream(request, response, ctx = {}) {
  const runTurn = ctx.runTurn ?? runAgentTurn;
  const payload = await readChatBody(request);
  const userMessage = optionalString(payload?.message ?? payload?.userMessage);

  if (!userMessage) {
    sendJsonError(response, 400, 'empty_message');
    return;
  }

  const systemPrompt = joinPrompts(
    optionalString(ctx.baseSystemPrompt),
    optionalString(payload?.systemPrompt),
  );
  // Tools run when the founder has granted capabilities (approved skills) —
  // the client may still opt out with tools:false. With no grants the turn is
  // chat-only exactly as before.
  const toolGrants = ctx.toolGrants instanceof Set ? ctx.toolGrants : new Set(ctx.toolGrants ?? []);
  const toolsEnabled = payload?.tools === true || (toolGrants.size > 0 && payload?.tools !== false);
  const substrateBlock = await resolveSubstrateBlock(ctx, userMessage);

  const turnAbort = new AbortController();
  const stopDisconnectWatch = watchClientDisconnect(request, response, turnAbort);

  openSseStream(response);
  const stopKeepAlive = startSseKeepAlive(response, ctx.keepAliveIntervalMs ?? DEFAULT_SSE_KEEP_ALIVE_MS);

  // G2-week ground truth: one diagnostic line per turn. Timing is monotonic;
  // the append never throws into the turn path (diagnostics.mjs swallows).
  const startedAt = performance.now();
  let ttftMs;
  const diag = { ok: false, errorCode: undefined };

  try {
    // Tokens stream LIVE — first-visible latency is a product requirement. A
    // mid-stream sovereign failure still silences (error event, no frontier,
    // no upstream echo — SEC-002); already-streamed text was the founder's own
    // sovereign content, which SEC-002 does not require unseeing.
    const result = await runTurn(
      {
        userMessage,
        history: Array.isArray(payload?.history) ? payload.history : undefined,
        historyMaxChars: CHAT_HISTORY_MAX_CHARS,
        systemPrompt,
        substrateBlock,
        substratePresent: Boolean(substrateBlock),
        sovereignFloor: true,
        selfReview: nextSelfReviewNudge(),
        dataDir: ctx.dataDir,
        now: ctx.now,
        tools: toolsEnabled,
        toolGrants,
        signal: turnAbort.signal,
        onToken: (delta) => {
          if (ttftMs === undefined) ttftMs = performance.now() - startedAt;
          writeSseEvent(response, 'token', { text: delta });
        },
      },
      ctx.deps ?? {},
    );

    writeSseEvent(response, 'done', {
      ok: true,
      lane: result.lane,
      sensitivity: result.sensitivity,
      sovereign: result.sovereign,
      steps: result.steps,
      held: result.held,
      content: result.content,
      ...(result.glaze ? { glaze: { score: result.glaze.score } } : {}),
    });
    Object.assign(diag, {
      ok: true,
      lane: result.lane,
      sensitivity: result.sensitivity,
      sovereign: result.sovereign,
      steps: result.steps,
      held: Array.isArray(result.held) ? result.held.length : 0,
      glazeScore: result.glaze?.score,
    });
  } catch (error) {
    // SEC-002: a sovereign-lane failure SILENCES — emit a bounded failure event,
    // never fall back to the frontier and never echo the upstream body.
    if (error instanceof SovereignLaneError) {
      writeSseEvent(response, 'error', { ok: false, error: 'sovereign_lane_unavailable', silenced: true });
      diag.errorCode = 'sovereign_lane_unavailable';
    } else {
      writeSseEvent(response, 'error', { ok: false, error: 'chat_failed' });
      diag.errorCode = 'chat_failed';
    }
  } finally {
    stopKeepAlive();
    stopDisconnectWatch();
    if (!response.writableEnded && !response.destroyed) response.end();
    await appendDiagnostic({
      dataDir: ctx.dataDir,
      turn: { ...diag, ttftMs: ttftMs ?? null, totalMs: performance.now() - startedAt },
    });
  }
}

function joinPrompts(...parts) {
  const joined = parts.filter(Boolean).join('\n\n');
  return joined || undefined;
}

async function resolveSubstrateBlock(ctx, userMessage) {
  const direct = optionalString(ctx.substrateBlock);
  if (direct) return direct;

  if (typeof ctx.buildSubstrateBlock !== 'function') return undefined;
  const built = await ctx.buildSubstrateBlock(userMessage);
  return optionalString(typeof built === 'string' ? built : built?.block) ?? undefined;
}

async function readChatBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CHAT_BODY_BYTES) {
      throw httpError(413, 'body_too_large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

function openSseStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function startSseKeepAlive(response, intervalMs) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return () => {};

  const interval = setInterval(() => {
    writeSseComment(response, 'ping');
  }, Math.floor(ms));
  if (typeof interval.unref === 'function') interval.unref();

  return () => clearInterval(interval);
}

function writeSseComment(response, comment) {
  if (response.writableEnded || response.destroyed) return;
  try {
    response.write(`: ${comment}\n\n`);
  } catch {
    // A disconnect races with the abort path; the abort signal is authoritative.
  }
}

function writeSseEvent(response, event, data) {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function watchClientDisconnect(request, response, controller) {
  const abort = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort();
    }
  };
  const watchers = [
    [request, 'aborted', abort],
    [request, 'close', abort],
    [response, 'close', abort],
  ].filter(([emitter]) => typeof emitter?.on === 'function');

  for (const [emitter, event, handler] of watchers) {
    emitter.on(event, handler);
  }

  return () => {
    for (const [emitter, event, handler] of watchers) {
      if (typeof emitter.off === 'function') emitter.off(event, handler);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler);
    }
  };
}

function sendJsonError(response, statusCode, code) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify({ ok: false, error: code })}\n`);
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}

export { DEFAULT_SSE_KEEP_ALIVE_MS, MAX_CHAT_BODY_BYTES };

export function nextSelfReviewNudge() {
  selfReviewTurnCounter += 1;
  return selfReviewTurnCounter % SELF_REVIEW_NUDGE_EVERY_TURNS === 0;
}

export function resetSelfReviewTurnCounterForTests(value = 0) {
  selfReviewTurnCounter = Number.isInteger(value) && value >= 0 ? value : 0;
}
