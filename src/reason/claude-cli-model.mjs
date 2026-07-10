import { spawn } from 'node:child_process';

import { optionalString, requiredString } from '../substrate.mjs';
import {
  promptTokenEstimate,
  recordModelMetric,
} from '../metrics/instrument.mjs';

// INTERIM SOVEREIGN PROVIDER — founder-directed 2026-07-05 ("use claude cli
// subscription for the time being") while the OpenRouter ZDR lane is down (402).
// This routes sovereign-lane prompts to Anthropic via the founder's Claude
// subscription (claude CLI print mode) — a named, temporary exception to the
// ZDR floor, reverted by removing K_SOVEREIGN_PROVIDER from the daemon env.
// Contract vs openRouterZdrModelCall: completion-only. Tool schemas in the
// request are accepted but never produce toolCalls (the advisory shell holds
// all tool calls anyway); streaming degrades to one onToken with the full text.

export const CLAUDE_CLI_PROVIDER = 'claude-cli';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_SYSTEM_CHARS = 200_000;
const MAX_OUTPUT_CHARS = 400_000;
// Completion-only providers cannot emit toolCalls. When the caller forced a tool
// schema, instruct strict JSON so the single-call adapter can parse arguments
// from content instead (see sovereign-single-call extractToolArguments).
function jsonGuard(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const fn = tools[0]?.function ?? tools[0];
  if (!fn?.name) return '';
  const schema = fn.parameters ?? fn.input_schema;
  return [
    `Respond ONLY with a single JSON object of arguments for "${fn.name}"`,
    schema ? `matching this JSON schema: ${JSON.stringify(schema)}` : '',
    '— no prose, no code fences, no explanation.',
  ].filter(Boolean).join(' ');
}

const COMPLETION_GUARD = [
  'You are a completion endpoint inside a larger system.',
  'Respond with the answer text only. Never use tools, never ask to run commands,',
  'never describe what you would do — produce the requested output directly.',
].join(' ');

export function sovereignProviderName(env = process.env) {
  return optionalString(env.K_SOVEREIGN_PROVIDER)?.trim() ?? '';
}

export async function claudeCliModelCall(request, opts = {}) {
  const startedAt = Date.now();
  const spawnImpl = opts.spawnImpl ?? spawn;
  const env = opts.env ?? process.env;
  const binary = optionalString(env.K_CLAUDE_CLI_PATH) ?? 'claude';
  const model = optionalString(env.K_CLAUDE_CLI_MODEL);
  const timeoutMs = normalizeTimeout(opts.timeoutMs ?? request?.timeoutMs, DEFAULT_TIMEOUT_MS);
  const hasTools = Array.isArray(request?.tools ?? opts.tools) && (request?.tools ?? opts.tools).length > 0;
  const onToken = typeof request?.onToken === 'function' ? request.onToken : opts.onToken;

  const { system, prompt } = composePrompt(request);
  if (system.length > MAX_SYSTEM_CHARS) {
    throw new Error(`claude-cli system prompt too large (${system.length} chars)`);
  }

  const args = [
    '-p',
    '--output-format', 'text',
    '--system-prompt', system,
    ...(model ? ['--model', model] : []),
  ];

  // Subscription lane: strip ANTHROPIC_API_KEY so the CLI cannot silently
  // switch to API billing; inherit the rest (HOME carries CLI auth).
  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;

  let content = '';
  try {
    content = await runClaudeCli({ spawnImpl, binary, args, prompt, timeoutMs, env: childEnv });
    const text = requiredString(content.trim(), 'claude-cli assistant content');
    if (typeof onToken === 'function') onToken(text);
    if (hasTools) {
      // Completion-only interim: tool schemas acknowledged, no toolCalls emitted.
      return Object.freeze({ content: text, reasoning: '', toolCalls: Object.freeze([]) });
    }
    return text;
  } finally {
    recordModelMetric({
      seam: 'claudeCliModelCall',
      lane: 'sovereign',
      model: model ?? 'claude-cli-default',
      ms: Date.now() - startedAt,
      promptTokens: promptTokenEstimate(request),
      completionTokens: undefined,
      result: content,
    });
  }
}

function composePrompt(request) {
  const guardedSystem = (extra) => [COMPLETION_GUARD, jsonGuard(request), extra]
    .filter(Boolean)
    .join('\n\n');

  if (Array.isArray(request?.messages) && request.messages.length > 0) {
    const systemParts = [];
    const turns = [];
    for (const message of request.messages) {
      const role = optionalString(message?.role) ?? 'user';
      const text = typeof message?.content === 'string' ? message.content : String(message?.content ?? '');
      if (role === 'system') {
        systemParts.push(text);
      } else {
        turns.push(`[${role}]\n${text}`);
      }
    }
    return {
      system: guardedSystem(systemParts.join('\n\n')),
      prompt: turns.join('\n\n') || '[user]\n',
    };
  }

  const user = requiredString(request?.user ?? request?.prompt, 'claude-cli user prompt');
  return {
    system: guardedSystem(optionalString(request?.system) ?? ''),
    prompt: user,
  };
}

function runClaudeCli({ spawnImpl, binary, args, prompt, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const child = spawnImpl(binary, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(reject, new Error(`claude-cli call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => finish(reject, new Error(`claude-cli spawn failed: ${error.message}`)));
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > MAX_OUTPUT_CHARS) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(reject, new Error('claude-cli output exceeded cap'));
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, stdout);
        return;
      }
      // Sensitive lane: surface exit code + bounded stderr head; stderr from the
      // CLI is operational (auth/usage errors), not prompt content.
      finish(reject, new Error(`claude-cli exited ${code}: ${stderr.slice(0, 300).trim()}`));
    });

    child.stdin?.end(prompt);
  });
}

function normalizeTimeout(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
