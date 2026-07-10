import { openRouterZdrModelCall } from '../reason/sensitive-model.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';

export async function openRouterZdrSingleCall(request, opts = {}) {
  const tool = isPlainObject(request?.tool) ? request.tool : null;
  const requestForSovereign = sovereignRequest(request, opts, tool);
  // The single-call adapter backs the reasoning-heavy paths (Board deliberation,
  // strategize) — enable GLM's chain-of-thought here by default. The interactive
  // chat lane calls openRouterZdrModelCall directly and stays reasoning-off/fast.
  const raw = await openRouterZdrModelCall(requestForSovereign, { reasoning: true, ...opts });

  if (!tool) return raw;
  return extractToolArguments(raw, tool.name);
}

function sovereignRequest(request, opts, tool) {
  const {
    model: _ignoredModel,
    tool: _ignoredTool,
    maxTokens,
    max_tokens,
    ...rest
  } = request ?? {};

  return {
    ...rest,
    ...(opts.model ? { model: opts.model } : {}),
    max_tokens: max_tokens ?? maxTokens,
    ...(tool ? {
      tools: [openAiFunctionTool(tool)],
      tool_choice: {
        type: 'function',
        function: { name: tool.name },
      },
    } : {}),
  };
}

function openAiFunctionTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: optionalString(tool.description) ?? '',
      parameters: isPlainObject(tool.input_schema)
        ? tool.input_schema
        : { type: 'object', properties: {} },
    },
  };
}

function extractToolArguments(raw, toolName) {
  if (isPlainObject(raw) && Array.isArray(raw.toolCalls)) {
    const call = raw.toolCalls.find((item) => item?.name === toolName) ?? raw.toolCalls[0];
    if (call) return parseArguments(call.arguments);
    // Completion-only providers (claude-cli interim) return the forced-tool
    // arguments as JSON content instead of a toolCall — parse it.
    const fromContent = argumentsFromContent(raw.content);
    if (fromContent) return fromContent;
  }

  if (isPlainObject(raw) && isPlainObject(raw[toolName])) return raw[toolName];
  if (isPlainObject(raw) && !Array.isArray(raw.toolCalls)) return raw;

  throw new Error(`sovereign model did not return ${toolName}`);
}

function argumentsFromContent(content) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  for (const candidate of [unfenced, jsonSlice(unfenced)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function jsonSlice(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : '';
}

function parseArguments(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
