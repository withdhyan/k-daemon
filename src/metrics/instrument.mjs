let metricsHook = null;

const SEAM_LANES = Object.freeze({
  defaultModelCall: 'frontier',
  openRouterZdrModelCall: 'sovereign',
  localOllamaModelCall: 'local',
});

export function setMetricsHook(hook) {
  if (hook !== null && hook !== undefined && typeof hook.record !== 'function') {
    throw new Error('metrics hook must expose record(sample)');
  }
  metricsHook = hook ?? null;
  return metricsHook;
}

export function getMetricsHook() {
  return metricsHook;
}

export function recordModelMetric(input = {}) {
  const hook = metricsHook;
  if (!hook || typeof hook.record !== 'function') return null;

  const promptTokens = nonNegativeNumber(input.promptTokens ?? input.prompt_tok);
  const completionTokens = nonNegativeNumber(
    input.completionTokens ??
    input.completion_tok ??
    estimateResultTokens(input.result),
  );
  const ms = nonNegativeNumber(input.ms);
  const genMs = nonNegativeNumber(input.gen_ms) || ms;
  const ttftMs = nonNegativeNumber(input.ttft_ms) || genMs;
  const sample = {
    seam: String(input.seam ?? 'unknown'),
    lane: input.lane ?? SEAM_LANES[input.seam] ?? 'frontier',
    model: typeof input.model === 'string' ? input.model : 'unknown',
    tokens: promptTokens + completionTokens,
    ms,
    prompt_tok: promptTokens,
    completion_tok: completionTokens,
    ttft_ms: ttftMs,
    gen_ms: genMs,
  };

  try {
    return hook.record(sample);
  } catch {
    return null;
  }
}

export function promptTokenEstimate(request) {
  return estimateTokens([
    request?.system,
    request?.user,
    request?.prompt,
    Array.isArray(request?.messages)
      ? request.messages.map((message) => message?.content).join('\n')
      : '',
  ].filter(Boolean).join('\n'));
}

export function estimateResultTokens(result) {
  if (typeof result === 'string') return estimateTokens(result);
  if (!result || typeof result !== 'object') return 0;
  if (typeof result.response === 'string') return estimateTokens(result.response);
  if (typeof result.content === 'string') return estimateTokens(result.content);
  return 0;
}

function estimateTokens(text) {
  const length = typeof text === 'string' ? text.length : 0;
  return length > 0 ? Math.ceil(length / 4) : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
