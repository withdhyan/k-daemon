// AG-UI transport for the cs-k agent shell.
//
// POST /api/agui/message — SSE ViewPacket stream. Loopback/Tailscale bind only
// (the server's post-listen bind assertion enforces this; this route adds no
// egress). The route wires the same chat engine as /api/chat: KTD9-routed
// (sensitive -> sovereign lane, SEC-001/002), governed tool loop, `[auto]`-empty.

import { performance } from 'node:perf_hooks';

import { heldNotice, runAgentTurn, SovereignLaneError } from '../../src/agent/chat.mjs';
import { DEFAULT_HISTORY_MAX_CHARS } from '../../src/agent/compaction.mjs';
import { appendDiagnostic } from '../../src/agent/diagnostics.mjs';
import {
  buildAnswerPacket,
  createAnswerPatchEmitter,
} from '../../src/agent/packet-emit.mjs';
import { runGovernedToolAction } from '../../src/agent/tool-loop.mjs';
import {
  buildViewPacket,
  validatePacketPatch,
  validateViewPacket,
} from '../../src/agent/view-packet.mjs';
import { isPlainObject, optionalString } from '../../src/substrate.mjs';

export const AGUI_MESSAGE_PATH = '/api/agui/message';
export const AGUI_EVENTS_PATH = '/api/agui/events';
export const AGUI_HISTORY_MAX_CHARS = DEFAULT_HISTORY_MAX_CHARS;
export const AGUI_PACKET_PATCH_EVENT = 'packet_patch';
export const AGUI_ACTION_INVOKE_TYPE = 'action-invoke';

const MAX_AGUI_BODY_BYTES = 256_000;
const DEFAULT_SSE_KEEP_ALIVE_MS = 10_000;
const RECENT_PACKET_LIMIT = 512;
const recentPackets = new Map();

/**
 * Handle POST /api/agui/message as an SSE ViewPacket stream.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {object} ctx - injectable wiring:
 *   - runTurn?          the agent engine (defaults to runAgentTurn; overridden in tests)
 *   - baseSystemPrompt? K's persona, prepended to any caller-supplied systemPrompt
 *   - substrateBlock?   assembled frontier-safe substrate context (grounds the turn)
 *   - buildSubstrateBlock? async function(userMessage): assembles sovereign
 *                      context after this route parses the request body
 *   - deps?             the engine's model-call/tool deps
 *   - keepAliveIntervalMs? SSE comment keep-alive interval (tests may shrink it)
 */
export async function handleAguiMessage(request, response, ctx = {}) {
  const method = ctx.method ?? request.method;
  const pathname = ctx.pathname ?? requestPathname(request);

  if (method === 'GET' && pathname === AGUI_EVENTS_PATH) {
    await handleAguiEvents(request, response, ctx);
    return;
  }

  if (method && method !== 'POST') {
    sendJsonError(response, 405, 'method_not_allowed');
    return;
  }

  let payload;
  try {
    payload = await readAguiBody(request);
  } catch (error) {
    if (error?.expose === true && Number.isInteger(error.statusCode)) {
      sendJsonError(response, error.statusCode, error.code);
      return;
    }
    throw error;
  }

  if (isActionInvokePayload(payload)) {
    await handleAguiActionInvoke(request, response, payload, ctx);
    return;
  }

  const runTurn = ctx.runTurn ?? runAgentTurn;
  const userMessage = optionalString(payload?.message ?? payload?.userMessage);

  if (!userMessage) {
    sendJsonError(response, 400, 'empty_message');
    return;
  }

  const systemPrompt = joinPrompts(
    optionalString(ctx.baseSystemPrompt),
    optionalString(payload?.systemPrompt),
  );
  const toolGrants = ctx.toolGrants instanceof Set ? ctx.toolGrants : new Set(ctx.toolGrants ?? []);
  const toolsEnabled = payload?.tools === true || (toolGrants.size > 0 && payload?.tools !== false);
  const substrateBlock = await resolveSubstrateBlock(ctx, userMessage);

  const turnAbort = new AbortController();
  const stopDisconnectWatch = watchClientDisconnect(request, response, turnAbort);

  openSseStream(response);
  writeSseComment(response, 'ready');
  const stopKeepAlive = startSseKeepAlive(response, ctx.keepAliveIntervalMs ?? DEFAULT_SSE_KEEP_ALIVE_MS);

  const startedAt = performance.now();
  let ttftMs;
  const diag = { ok: false, errorCode: undefined };
  const patchStream = createAnswerPatchEmitter({
    lane: 'sovereign',
    sensitivity: 'sensitive',
    sovereign: true,
    status: 'streaming',
    provenance: {
      surface: 'verbatim-chat',
      lane: 'sovereign',
      plane: 'agent',
      module: 'agui',
    },
  }, {
    sensitivity: 'sensitive',
    module: 'agui',
    logger: ctx.logger,
  });
  const patchBasePacket = patchStream.packet;
  const patchEvents = [];
  const enqueuePatch = (patch) => {
    if (patch) patchEvents.push(validatePacketPatch(patch));
  };

  try {
    const result = await runTurn(
      {
        userMessage,
        history: Array.isArray(payload?.history) ? payload.history : undefined,
        historyMaxChars: AGUI_HISTORY_MAX_CHARS,
        systemPrompt,
        substrateBlock,
        substratePresent: Boolean(substrateBlock),
        sovereignFloor: true,
        selfReview: false,
        dataDir: ctx.dataDir,
        now: ctx.now,
        tools: toolsEnabled,
        toolGrants,
        signal: turnAbort.signal,
        // U6 seam: token deltas become AG-UI patch packets here. The transport
        // flushes the queued base+patches only after success so SEC-002 failures
        // do not leak partial patch content.
        onToken: (delta) => {
          if (ttftMs === undefined) ttftMs = performance.now() - startedAt;
          enqueuePatch(patchStream.pushToken(delta));
        },
      },
      ctx.deps ?? {},
    );

    const packet = rememberPacket(responsePacketFromTurn(result));
    for (const child of packet.children ?? []) {
      enqueuePatch(patchStream.appendChild(child));
    }
    if (ttftMs === undefined) ttftMs = performance.now() - startedAt;
    if (patchEvents.length > 0) {
      writeSseEvent(response, 'packet', rememberPacket(patchBasePacket));
    }
    for (const patch of patchEvents) {
      writeSseEvent(response, AGUI_PACKET_PATCH_EVENT, patch);
    }
    writeSseEvent(response, 'packet', packet);
    writeSseEvent(response, 'done', {
      ok: true,
      packetId: packet.id,
      lane: result.lane,
      sensitivity: result.sensitivity,
      sovereign: result.sovereign,
      steps: result.steps,
      held: result.held,
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
    // SEC-002: a sovereign-lane failure SILENCES - emit a bounded failure event,
    // never fall back to the frontier and never echo the upstream body.
    if (error instanceof SovereignLaneError) {
      writeSseEvent(response, 'error', { ok: false, error: 'sovereign_lane_unavailable', silenced: true });
      diag.errorCode = 'sovereign_lane_unavailable';
    } else {
      writeSseEvent(response, 'error', { ok: false, error: 'agui_failed' });
      diag.errorCode = 'agui_failed';
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

export function isAguiPath(pathname) {
  return pathname === AGUI_MESSAGE_PATH || pathname === AGUI_EVENTS_PATH;
}

async function handleAguiActionInvoke(request, response, payload, ctx = {}) {
  const message = actionInvokeMessage(payload);
  const packetId = optionalString(message?.packetId ?? message?.packet_id);
  const requestedAction = normalizeInvokeAction(message);

  const turnAbort = new AbortController();
  const stopDisconnectWatch = watchClientDisconnect(request, response, turnAbort);

  openSseStream(response);
  const stopKeepAlive = startSseKeepAlive(response, ctx.keepAliveIntervalMs ?? DEFAULT_SSE_KEEP_ALIVE_MS);

  const startedAt = performance.now();
  let ttftMs;
  const diag = { ok: false, errorCode: undefined, action: true };

  try {
    const sourcePacket = packetId ? resolveKnownPacket(packetId, payload, ctx) : null;
    if (!sourcePacket) {
      logActionWarning(ctx.logger, 'unknown_packet_id', { packetId, action: requestedAction });
      const packet = rememberPacket(buildActionErrorPacket({
        code: 'unknown_packet_id',
        packetId,
        action: requestedAction,
        frontierExcluded: true,
      }));
      ttftMs = performance.now() - startedAt;
      writeSseEvent(response, 'packet', packet);
      writeSseEvent(response, 'done', actionDoneEnvelope({
        ok: false,
        status: 'error',
        code: 'unknown_packet_id',
        resultPacket: packet,
        packetId,
        action: requestedAction,
      }));
      Object.assign(diag, { errorCode: 'unknown_packet_id' });
      return;
    }

    const action = resolveInvokedAction(sourcePacket, requestedAction);
    if (!action.ok) {
      logActionWarning(ctx.logger, action.code, { packetId: sourcePacket.id, action: requestedAction });
      const packet = rememberPacket(buildActionErrorPacket({
        code: action.code,
        packetId: sourcePacket.id,
        action: requestedAction,
        sourcePacket,
      }));
      ttftMs = performance.now() - startedAt;
      writeSseEvent(response, 'packet', packet);
      writeSseEvent(response, 'done', actionDoneEnvelope({
        ok: false,
        status: 'error',
        code: action.code,
        resultPacket: packet,
        packetId: sourcePacket.id,
        action: requestedAction,
      }));
      Object.assign(diag, { errorCode: action.code });
      return;
    }

    const toolGrants = ctx.toolGrants instanceof Set ? ctx.toolGrants : new Set(ctx.toolGrants ?? []);
    const runActionLoop = ctx.runActionLoop ?? runGovernedToolAction;
    const executor = ctx.deps?.toolExecutor ?? ctx.toolExecutor ?? defaultActionExecutor;
    const loop = await runActionLoop({
      intent: action.intent,
      actionId: action.id,
      args: action.args,
      grants: toolGrants,
      executor,
      sovereign: sourcePacket.frontierExcluded === true,
      nativeTools: true,
      signal: turnAbort.signal,
    });
    const packet = rememberPacket(actionPacketFromLoop({ sourcePacket, action, loop }));
    const status = optionalString(packet.fields?.status) ?? 'ok';

    ttftMs = performance.now() - startedAt;
    writeSseEvent(response, 'packet', packet);
    writeSseEvent(response, 'done', actionDoneEnvelope({
      ok: status === 'ok',
      status,
      resultPacket: packet,
      packetId: sourcePacket.id,
      action,
      loop,
    }));
    Object.assign(diag, {
      ok: status === 'ok',
      errorCode: status === 'ok' ? undefined : optionalString(packet.fields?.code ?? packet.fields?.reason),
      steps: Number(loop?.steps ?? 0),
      held: Array.isArray(loop?.held) ? loop.held.length : 0,
    });
  } catch (error) {
    logActionWarning(ctx.logger, 'action_failed', { packetId, action: requestedAction });
    const packet = rememberPacket(buildActionErrorPacket({
      code: 'action_failed',
      packetId,
      action: requestedAction,
      frontierExcluded: true,
    }));
    ttftMs = performance.now() - startedAt;
    writeSseEvent(response, 'packet', packet);
    writeSseEvent(response, 'done', actionDoneEnvelope({
      ok: false,
      status: 'error',
      code: 'action_failed',
      resultPacket: packet,
      packetId,
      action: requestedAction,
    }));
    Object.assign(diag, { errorCode: 'action_failed' });
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

function responsePacketFromTurn(result = {}) {
  return validateViewPacket(buildAnswerPacket(result, { module: 'agui' }));
}

function isActionInvokePayload(payload) {
  const message = actionInvokeMessage(payload);
  return optionalString(message?.type ?? message?.event) === AGUI_ACTION_INVOKE_TYPE;
}

function actionInvokeMessage(payload) {
  return isPlainObject(payload?.message) ? payload.message : payload;
}

function normalizeInvokeAction(message = {}) {
  const rawAction = messageActionObject(message);
  const args = actionArgs(rawAction, message);
  return {
    id: optionalString(
      rawAction.id ??
      rawAction.actionId ??
      message.actionId ??
      message.action_id,
    ),
    intent: optionalString(
      rawAction.intent ??
      rawAction.intentName ??
      rawAction.kind ??
      rawAction.name ??
      rawAction.toolId ??
      message.intent ??
      message.intentName ??
      (typeof message.action === 'string' ? message.action : undefined),
    ),
    args: args.value,
    argsProvided: args.provided,
  };
}

function messageActionObject(message = {}) {
  if (isPlainObject(message.action)) return message.action;
  if (isPlainObject(message.actionIntent)) return message.actionIntent;
  if (isPlainObject(message.intent)) return message.intent;
  return {};
}

function actionArgs(rawAction, message) {
  for (const value of [
    rawAction.args,
    rawAction.arguments,
    message.args,
    message.arguments,
  ]) {
    if (isPlainObject(value)) return { value, provided: true };
  }
  return { value: {}, provided: false };
}

function resolveKnownPacket(packetId, payload, ctx) {
  for (const packet of packetCandidates(payload, ctx)) {
    try {
      const remembered = rememberPacket(packet);
      const found = findPacketById(remembered, packetId);
      if (found) return found;
    } catch {
      // Candidate packet was malformed or stale. Ignore it and keep looking in
      // the bounded packet index; action-invoke itself returns a packet error.
    }
  }
  return recentPackets.get(packetId) ?? null;
}

function packetCandidates(payload, ctx) {
  return [
    ...packetList(ctx?.packets),
    ...packetList(ctx?.packet),
    ...packetList(payload?.packets),
    ...packetList(payload?.packet),
    ...packetList(payload?.viewPacket),
  ];
}

function packetList(value) {
  if (Array.isArray(value)) return value;
  return isPlainObject(value) ? [value] : [];
}

function findPacketById(packet, packetId) {
  if (packet?.id === packetId) return packet;
  for (const child of packet?.children ?? []) {
    const found = findPacketById(child, packetId);
    if (found) return found;
  }
  return null;
}

function rememberPacket(packet) {
  const validated = validateViewPacket(packet);
  rememberPacketNode(validated);
  return validated;
}

function rememberPacketNode(packet) {
  recentPackets.set(packet.id, packet);
  while (recentPackets.size > RECENT_PACKET_LIMIT) {
    recentPackets.delete(recentPackets.keys().next().value);
  }
  for (const child of packet.children ?? []) rememberPacketNode(child);
}

function resolveInvokedAction(packet, requestedAction) {
  if (!isPlainObject(packet?.action)) {
    return { ok: false, code: 'unknown_intent' };
  }

  const packetIntent = packetActionIntent(packet.action);
  if (!requestedAction.intent || requestedAction.intent !== packetIntent) {
    return { ok: false, code: 'unknown_intent' };
  }

  const packetActionId = optionalString(packet.action.id ?? packet.action.actionId ?? packet.action.target);
  if (requestedAction.id && packetActionId && requestedAction.id !== packetActionId) {
    return { ok: false, code: 'unknown_intent' };
  }

  return {
    ok: true,
    id: requestedAction.id ?? packetActionId,
    intent: packetIntent,
    args: requestedAction.argsProvided
      ? requestedAction.args
      : isPlainObject(packet.action.args)
        ? packet.action.args
        : {},
  };
}

function packetActionIntent(action) {
  return optionalString(action.intent ?? action.intentName ?? action.kind ?? action.name ?? action.toolId);
}

function actionPacketFromLoop({ sourcePacket, action, loop }) {
  const held = heldDescriptors(loop?.held, action.intent);
  if (held.length > 0 && !hasExecuted(loop)) {
    return buildActionHeldPacket({ sourcePacket, action, held, loop });
  }

  const result = Array.isArray(loop?.executed) ? loop.executed[0] : null;
  if (!result) {
    return buildActionErrorPacket({
      code: 'no_action_result',
      packetId: sourcePacket.id,
      action,
      sourcePacket,
    });
  }

  if (result.held === true) {
    return buildActionHeldPacket({
      sourcePacket,
      action,
      held: heldDescriptors([{ id: result.toolId, reason: result.reason || 'held_for_human_gate' }], action.intent),
      loop,
      result,
    });
  }

  if (result.ok !== true) {
    return buildActionErrorPacket({
      code: result.reason || 'tool_failed',
      packetId: sourcePacket.id,
      action,
      sourcePacket,
      result,
    });
  }

  const frontierExcluded = actionFrontierExcluded(sourcePacket, loop, result);
  return validateViewPacket(buildViewPacket({
    viewType: 'preview.tool',
    text: result.output || `${action.intent} completed.`,
    fields: {
      status: 'ok',
      packetId: sourcePacket.id,
      actionId: action.id,
      intent: action.intent,
      toolId: result.toolId,
      ok: true,
    },
    provenance: actionProvenance(frontierExcluded),
    frontierExcluded,
  }));
}

function hasExecuted(loop) {
  return Array.isArray(loop?.executed) && loop.executed.length > 0;
}

function buildActionHeldPacket({ sourcePacket, action, held, loop, result }) {
  const frontierExcluded = actionFrontierExcluded(sourcePacket, loop, result);
  return validateViewPacket(buildViewPacket({
    viewType: 'preview.tool',
    text: heldNotice(held),
    fields: {
      status: 'held',
      packetId: sourcePacket.id,
      actionId: action.id,
      intent: action.intent,
      held,
      reason: held[0]?.reason,
    },
    provenance: actionProvenance(frontierExcluded),
    frontierExcluded,
  }));
}

function buildActionErrorPacket({ code, packetId, action, sourcePacket, result, frontierExcluded }) {
  const excluded = frontierExcluded === true ||
    sourcePacket?.frontierExcluded === true ||
    result?.sensitive === true ||
    !sourcePacket;
  return validateViewPacket(buildViewPacket({
    viewType: 'preview.tool',
    text: `Action could not run: ${code}.`,
    fields: {
      status: 'error',
      code,
      packetId,
      actionId: action?.id,
      intent: action?.intent,
      toolId: result?.toolId,
      ok: false,
      reason: result?.reason,
    },
    provenance: actionProvenance(excluded),
    frontierExcluded: excluded,
  }));
}

function actionFrontierExcluded(sourcePacket, loop, result) {
  return sourcePacket?.frontierExcluded === true ||
    loop?.sovereign === true ||
    result?.sensitive === true;
}

function actionProvenance(frontierExcluded) {
  return {
    surface: 'tool',
    lane: frontierExcluded ? 'sovereign' : 'deliberate',
    plane: 'agent',
    module: 'agui-action',
  };
}

function heldDescriptors(held, fallbackId) {
  if (!Array.isArray(held)) return [];
  return held.map((item) => ({
    id: optionalString(item?.id) ?? optionalString(fallbackId) ?? 'action',
    reason: optionalString(item?.reason) ?? 'held_for_human_gate',
  }));
}

function actionDoneEnvelope({ ok, status, code, resultPacket, packetId, action, loop }) {
  return {
    ok,
    status,
    ...(code ? { error: code } : {}),
    packetId: resultPacket.id,
    action: {
      packetId,
      actionId: action?.id,
      intent: action?.intent,
    },
    steps: Number(loop?.steps ?? 0),
    held: heldDescriptors(loop?.held, action?.intent),
    executed: executedSummaries(loop?.executed),
  };
}

function executedSummaries(executed) {
  if (!Array.isArray(executed)) return [];
  return executed.map((item) => ({
    toolId: item.toolId,
    ok: item.ok === true,
    held: item.held === true,
    ...(item.reason ? { reason: item.reason } : {}),
  }));
}

async function defaultActionExecutor(id) {
  return Object.freeze({
    toolId: id,
    ok: false,
    held: true,
    reason: 'no_executor_wired',
  });
}

function logActionWarning(logger = console, code, { packetId, action } = {}) {
  const intent = optionalString(action?.intent) ?? 'unknown';
  const id = optionalString(packetId) ?? 'unknown';
  logger?.warn?.(`[cs-k] agui action-invoke ${code}: packetId=${id} intent=${intent}`);
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

async function handleAguiEvents(request, response, ctx = {}) {
  const turnAbort = new AbortController();
  const stopDisconnectWatch = watchClientDisconnect(request, response, turnAbort);

  openSseStream(response);
  const stopKeepAlive = startSseKeepAlive(response, ctx.keepAliveIntervalMs ?? DEFAULT_SSE_KEEP_ALIVE_MS);
  let removeClient = () => {};
  let liveStream = false;

  try {
    const packets = Array.isArray(ctx.packets)
      ? ctx.packets
      : ctx.packet
        ? [ctx.packet]
        : [];
    for (const packet of packets) {
      writeSseEvent(response, 'packet', rememberPacket(validateViewPacket(packet)));
    }
    for (const patch of ctx.patches ?? []) {
      writeSseEvent(response, AGUI_PACKET_PATCH_EVENT, validatePacketPatch(patch));
    }
    if (isPacketEventBus(ctx.buildEvents)) {
      for (const packet of ctx.buildEvents.recentPackets(recentPacketLimit(ctx.searchParams))) {
        writeSseEvent(response, 'packet', rememberPacket(validateViewPacket(packet)));
      }
      removeClient = ctx.buildEvents.addClient(response);
      liveStream = true;
      const cleanup = once(() => {
        stopKeepAlive();
        stopDisconnectWatch();
        removeClient();
      });
      turnAbort.signal.addEventListener('abort', cleanup, { once: true });
      if (typeof response.once === 'function') response.once('close', cleanup);
      return;
    }
    writeSseEvent(response, 'done', { ok: true });
  } catch {
    writeSseEvent(response, 'error', { ok: false, error: 'agui_failed' });
  } finally {
    if (!liveStream) {
      stopKeepAlive();
      stopDisconnectWatch();
      removeClient();
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }
}

function isPacketEventBus(value) {
  return value &&
    typeof value.addClient === 'function' &&
    typeof value.recentPackets === 'function';
}

function recentPacketLimit(searchParams) {
  const value = searchParams?.get?.('packets');
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function once(fn) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

async function readAguiBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_AGUI_BODY_BYTES) {
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

export function writeSseEvent(response, event, data) {
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

function requestPathname(request) {
  const url = optionalString(request?.url);
  if (!url) return undefined;
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

export { DEFAULT_SSE_KEEP_ALIVE_MS, MAX_AGUI_BODY_BYTES };
