import { createHash } from 'node:crypto';

import { isPlainObject, optionalString } from '../substrate.mjs';
import { agentToolRegistry } from './tools.mjs';

const MAX_JSON_REPAIR_STEPS = 50;
const FUZZY_ACCEPTANCE = 0.7;

export function deterministicToolCallId(name, args, index = 0) {
  const hash = createHash('sha256')
    .update(`${optionalString(name) ?? ''}\n${typeof args === 'string' ? args : JSON.stringify(args ?? {})}\n${index}`)
    .digest('hex')
    .slice(0, 16);
  return `call_${hash}`;
}

export function repairToolCall(call = {}, options = {}) {
  const registry = Array.isArray(options.registry) ? options.registry : agentToolRegistry();
  const rawName = optionalString(call.name ?? call.id) ?? '';
  const callId = optionalString(call.callId) ??
    deterministicToolCallId(rawName, call.arguments ?? call.args, options.index ?? 0);

  if (!rawName) {
    return Object.freeze({
      ok: false,
      callId,
      name: '',
      message: 'that tool-call syntax is data, not a call',
      emptyName: true,
    });
  }

  const normalizedName = normalizeToolName(rawName, registry);
  if (!normalizedName) {
    const available = registry.map((tool) => tool.id).join(', ');
    return Object.freeze({
      ok: false,
      callId,
      name: rawName,
      message: `Tool '${rawName}' does not exist. Available tools: ${available}`,
      emptyName: false,
    });
  }

  return Object.freeze({
    ok: true,
    callId,
    id: normalizedName,
    originalName: rawName,
    args: repairJsonArguments(call.arguments ?? call.args),
  });
}

export function repairJsonArguments(value) {
  if (isPlainObject(value)) return value;
  if (value === undefined || value === null) return {};

  let source = String(value).trim();
  if (!source) return {};

  source = stripTrailingCommas(escapeRawControlChars(source));
  for (let attempt = 0; attempt <= MAX_JSON_REPAIR_STEPS; attempt += 1) {
    const parsed = parseJsonObject(source);
    if (parsed) return parsed;

    const repaired = closeOneUnclosedJsonContainer(stripTrailingCommas(source));
    if (repaired === source) break;
    source = repaired;
  }

  const closed = closeUnclosedJsonContainers(stripTrailingCommas(source));
  return parseJsonObject(closed) ?? {};
}

export function normalizeToolName(name, registry = agentToolRegistry()) {
  const raw = optionalString(name);
  if (!raw) return '';

  const target = toolNameKey(raw);
  if (!target) return '';

  const keyed = registry.map((tool) => Object.freeze({
    id: tool.id,
    key: toolNameKey(tool.id),
  }));
  const exact = keyed.find((tool) => tool.key === target);
  if (exact) return exact.id;

  const compact = target.replaceAll('_', '');
  const compactExact = keyed.find((tool) => tool.key.replaceAll('_', '') === compact);
  if (compactExact) return compactExact.id;

  let best = null;
  for (const tool of keyed) {
    const score = similarity(target, tool.key);
    if (!best || score > best.score) best = { id: tool.id, score };
  }

  return best && best.score >= FUZZY_ACCEPTANCE ? best.id : '';
}

function parseJsonObject(source) {
  try {
    const parsed = JSON.parse(source);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function stripTrailingCommas(source) {
  return source.replace(/,\s*([}\]])/g, '$1');
}

function escapeRawControlChars(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
        output += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        output += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        output += char;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        output += controlEscape(char);
        continue;
      }
      output += char;
      continue;
    }

    if (char === '"') inString = true;
    output += char;
  }

  return output;
}

function controlEscape(char) {
  switch (char) {
    case '\b': return '\\b';
    case '\f': return '\\f';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    default:
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
}

function closeOneUnclosedJsonContainer(source) {
  const closers = unclosedJsonClosers(source);
  return closers.length > 0 ? source + closers[0] : source;
}

function closeUnclosedJsonContainers(source) {
  return source + unclosedJsonClosers(source).slice(0, MAX_JSON_REPAIR_STEPS).join('');
}

function unclosedJsonClosers(source) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { stack.push('}'); continue; }
    if (char === '[') { stack.push(']'); continue; }
    if ((char === '}' || char === ']') && stack.at(-1) === char) stack.pop();
  }

  return stack.reverse();
}

function toolNameKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function similarity(left, right) {
  const max = Math.max(left.length, right.length);
  if (max === 0) return 1;
  return 1 - editDistance(left, right) / max;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }

  return previous[right.length];
}
