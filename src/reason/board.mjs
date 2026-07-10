import {
  ADVISORS,
  DEVIL_ADVOCATE,
  INTEGRATION_AUDITOR_PROMPT,
} from './advisors.mjs';

const DEFAULT_INTERNAL_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_CHARS = 18_000;

const ADVISOR_TOOL = Object.freeze({
  name: 'board_advisor_analysis',
  description: 'Return one Board advisor analysis.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      analysis: { type: 'string' },
    },
    required: ['analysis'],
  },
});

const DEVIL_ADVOCATE_TOOL = Object.freeze({
  name: 'board_devil_advocate',
  description: 'Return one structurally distinct counter-position to the Board convergence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      contradicts: { type: 'boolean' },
      on: { type: 'string' },
    },
    required: ['contradicts', 'on'],
  },
});

const INTEGRATION_AUDITOR_TOOL = Object.freeze({
  name: 'board_integration_auditor',
  description: 'Return the structured synthesis of the Board of Advisors.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      convergence_points: {
        type: 'array',
        items: { type: 'string' },
      },
      tension: { type: 'string' },
      da_landed: { type: 'boolean' },
      synthesis: { type: 'string' },
      consider: { type: 'string' },
    },
    required: ['convergence_points', 'tension', 'da_landed', 'synthesis', 'consider'],
  },
});

export async function boardModelCall(request, options = {}) {
  const singleCall = options.singleCall;
  if (typeof singleCall !== 'function') {
    throw new Error('boardModelCall requires options.singleCall');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTERNAL_TIMEOUT_MS;

  try {
    const round1 = await runAdvisorRound1(request, { singleCall, timeoutMs });
    const round2 = await runAdvisorRound2(request, round1, { singleCall, timeoutMs });
    const da = await runDevilAdvocate(request, round2, { singleCall, timeoutMs });
    const auditor = await runIntegrationAuditor(request, round1, round2, da, {
      singleCall,
      timeoutMs,
    });

    return buildCommitOutput(request, round1, round2, da, auditor);
  } catch (error) {
    const fallbackMessage = options.fallbackToSingle === false
      ? 'returning control to the caller for single-call fallback'
      : 'falling back to single decide call';
    console.error(
      `[cs-k] Board internal pass failed; ${fallbackMessage}: ${error.message}`,
    );
    if (options.fallbackToSingle === false) throw error;
    return singleCall(request);
  }
}

async function runAdvisorRound1(request, options) {
  const pairs = await Promise.all(
    ADVISORS.map(async (advisor) => [
      advisor.name,
      await callAdvisor(request, advisor, 1, {
        ...options,
        user: [
          'question for the board:',
          '',
          extractAsked(request),
          '',
          'available decide context:',
          trimContext(request.user),
          '',
          'give your analysis from your domain lens. be specific. 150-250 words.',
        ].join('\n'),
      }),
    ]),
  );

  return Object.freeze(Object.fromEntries(pairs));
}

async function runAdvisorRound2(request, round1, options) {
  const pairs = await Promise.all(
    ADVISORS.map(async (advisor) => {
      const otherViews = Object.entries(round1)
        .filter(([name]) => name !== advisor.name)
        .map(([name, analysis]) => `**${name} advisor**: ${analysis}`)
        .join('\n\n');

      return [
        advisor.name,
        await callAdvisor(request, advisor, 2, {
          ...options,
          user: [
            `question: ${extractAsked(request)}`,
            '',
            `your round 1 analysis:\n${round1[advisor.name] ?? ''}`,
            '',
            `other advisors' round 1 views:\n${otherViews}`,
            '',
            'revise or reinforce your position based on what the other advisors saw.',
            'note where you agree, where you disagree, and what they missed from your lens.',
            '100-150 words.',
          ].join('\n'),
        }),
      ];
    }),
  );

  return Object.freeze(Object.fromEntries(pairs));
}

async function callAdvisor(request, advisor, round, options) {
  const output = await callBoardTool({
    request,
    singleCall: options.singleCall,
    timeoutMs: options.timeoutMs,
    label: `${baseLabel(request)}:board:round${round}:${advisor.name}`,
    tool: ADVISOR_TOOL,
    maxTokens: round === 1 ? 700 : 500,
    system: [request.system, '---', advisorSystem(advisor)].join('\n\n'),
    user: options.user,
  });

  return requiredStringField(output, 'analysis', `round ${round} ${advisor.name} analysis`);
}

async function runDevilAdvocate(request, round2, options) {
  const convergence = boardSummary(round2);
  let attempt = await callDevilAdvocate(request, convergence, options);
  let distinct = isDistinctCounterPosition(attempt.on, convergence) && attempt.contradicts === true;
  let reprompted = false;

  if (!distinct) {
    reprompted = true;
    attempt = await callDevilAdvocate(request, convergence, {
      ...options,
      retryBecause: attempt.on,
    });
    distinct = isDistinctCounterPosition(attempt.on, convergence) && attempt.contradicts === true;
  }

  return Object.freeze({
    ...attempt,
    structurallyDistinct: distinct,
    lowConfidence: !distinct,
    reprompted,
    on: attempt.on || 'no structurally distinct counter-position produced',
  });
}

async function callDevilAdvocate(request, convergence, options) {
  const retryText = options.retryBecause === undefined
    ? ''
    : [
        '',
        'your previous `on` field was empty or echoed the convergence.',
        'return a counter-position that is structurally distinct from the convergence.',
        `rejected on field: ${options.retryBecause || '(empty)'}`,
      ].join('\n');

  const output = await callBoardTool({
    request,
    singleCall: options.singleCall,
    timeoutMs: options.timeoutMs,
    label: `${baseLabel(request)}:board:devil-advocate${options.retryBecause === undefined ? '' : ':retry'}`,
    tool: DEVIL_ADVOCATE_TOOL,
    maxTokens: 450,
    system: [request.system, '---', advisorSystem(DEVIL_ADVOCATE)].join('\n\n'),
    user: [
      `question: ${extractAsked(request)}`,
      '',
      'the board is converging toward:',
      '',
      convergence,
      '',
      'attack the consensus. return `contradicts: true` and put the strongest counter-position in `on`.',
      'this code gate only checks structural distinctness, not whether the dissent is correct.',
      retryText,
    ].join('\n'),
  });

  return Object.freeze({
    contradicts: output?.contradicts === true,
    on: stringValue(output?.on),
  });
}

async function runIntegrationAuditor(request, round1, round2, da, options) {
  const output = await callBoardTool({
    request,
    singleCall: options.singleCall,
    timeoutMs: options.timeoutMs,
    label: `${baseLabel(request)}:board:integration-auditor`,
    tool: INTEGRATION_AUDITOR_TOOL,
    maxTokens: 900,
    system: [request.system, '---', INTEGRATION_AUDITOR_PROMPT].join('\n\n'),
    user: [
      `question: ${extractAsked(request)}`,
      '',
      `board round 1:\n${boardSummary(round1)}`,
      '',
      `board round 2:\n${boardSummary(round2)}`,
      '',
      "devil's advocate challenge:",
      JSON.stringify({
        contradicts: da.contradicts,
        on: da.on,
        structurallyDistinct: da.structurallyDistinct,
        lowConfidence: da.lowConfidence,
      }),
      '',
      'synthesise into the forced tool fields.',
      "if there is no strong convergence, put that explicitly in `convergence_points` rather than returning an empty array.",
    ].join('\n'),
  });

  return normalizeAuditorOutput(output);
}

async function callBoardTool({ request, singleCall, timeoutMs, label, tool, system, user, maxTokens }) {
  const internalRequest = {
    ...request,
    label,
    maxTokens,
    system,
    user,
    tool,
  };

  return withTimeout(() => singleCall(internalRequest), timeoutMs, label);
}

function buildCommitOutput(request, round1, round2, da, auditor) {
  const asked = extractAsked(request);
  const decisionCard = buildDecisionCard(request, round1, round2, da, auditor, asked);
  const summary = `Board synthesis: ${oneLine(auditor.synthesis || auditor.consider)}`;

  if (!isActionableConsider(auditor.consider)) {
    return {
      summary: summary || 'Board returned earned silence.',
      verdict: 'silence',
      decisionCard,
      dissent: dissentForOutput(da),
      convergence_points: auditor.convergence_points,
    };
  }

  const reversibility = inferReversibility([
    asked,
    auditor.consider,
    auditor.synthesis,
    auditor.tension,
    request.user,
  ].join('\n'));

  return {
    summary,
    verdict: 'recommend',
    recommendation: {
      decision: asked,
      recommended: auditor.consider,
      reason: oneLine(auditor.convergence_points[0] || auditor.synthesis),
      reversibility,
      undo: undoForReversibility(reversibility),
      evidenceIds: extractEvidenceIds(request.user),
      confidence: boardConfidence(auditor, da),
    },
    decisionCard,
    dissent: dissentForOutput(da),
    convergence_points: auditor.convergence_points,
  };
}

function dissentForOutput(da) {
  return Object.freeze({
    contradicts: da.contradicts === true,
    on: stringValue(da.on),
  });
}

function buildDecisionCard(request, round1, round2, da, auditor, asked) {
  const missing = [];
  if (auditor.tension) missing.push(`resolve tension: ${auditor.tension}`);
  if (da.lowConfidence) {
    missing.push('devil advocate did not produce a structurally distinct counter-position');
  }

  return Object.freeze({
    asked,
    read: extractRead(request),
    assumed: auditor.convergence_points,
    missing,
    pick: auditor.consider || 'silence',
    why: auditor.synthesis || auditor.convergence_points.join('; '),
    whatWouldChangeIt: auditor.da_landed
      ? `the devil advocate challenge would need to be resolved: ${da.on}`
      : `new evidence would need to overturn: ${auditor.convergence_points.join('; ')}`,
    next: nextStep(auditor.consider),
  });
}

function advisorSystem(advisor) {
  return [
    `you are ${advisor.name}, one of K's Board of Advisors.`,
    '',
    advisor.promptAddendum,
    '',
    `your domain: ${advisor.domain}`,
    `your lens: ${advisor.lens}`,
    `your known blind spot: ${advisor.blindSpot}`,
    '',
    "you are speaking to K's Integration Auditor. be direct and analytical.",
    'speak lowercase. use numbers when available. no hedging beyond genuine uncertainty.',
    'stage only advice; do not act on the world.',
  ].join('\n');
}

function normalizeAuditorOutput(output) {
  const convergencePoints = stringList(output?.convergence_points).filter(Boolean);
  if (convergencePoints.length === 0) {
    throw new Error('integration auditor returned no convergence_points');
  }

  return Object.freeze({
    convergence_points: Object.freeze(convergencePoints),
    tension: requiredStringField(output, 'tension', 'integration auditor tension'),
    da_landed: output?.da_landed === true,
    synthesis: requiredStringField(output, 'synthesis', 'integration auditor synthesis'),
    consider: requiredStringField(output, 'consider', 'integration auditor consider'),
  });
}

function isDistinctCounterPosition(on, convergence) {
  const normalizedOn = normalizeForComparison(on);
  if (normalizedOn.length < 12) return false;

  const normalizedConvergence = normalizeForComparison(convergence);
  if (normalizedConvergence.includes(normalizedOn)) return false;

  const onTokens = significantTokens(normalizedOn);
  if (onTokens.length < 3) return false;

  const convergenceTokens = new Set(significantTokens(normalizedConvergence));
  const overlap = onTokens.filter((token) => convergenceTokens.has(token)).length / onTokens.length;
  const distinctRatio =
    onTokens.filter((token) => !convergenceTokens.has(token)).length / onTokens.length;

  return overlap < 0.8 || distinctRatio >= 0.25;
}

function normalizeForComparison(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(value) {
  const stop = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'be',
    'but',
    'for',
    'from',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'that',
    'the',
    'this',
    'to',
    'with',
  ]);

  return normalizeForComparison(value)
    .split(' ')
    .filter((token) => token.length > 2 && !stop.has(token));
}

function boardSummary(outputs) {
  return Object.entries(outputs)
    .map(([name, analysis]) => `**${name}**: ${analysis}`)
    .join('\n\n');
}

function extractAsked(request) {
  const inputMatch = stringValue(request.user).match(/## This run input\n([\s\S]*?)(?:\n\n## |\s*$)/);
  const input = inputMatch?.[1]?.trim();
  if (input) return oneLine(input, 240);

  const decisionMatch = stringValue(request.user).match(/"decision"\s*:\s*"([^"]+)"/);
  if (decisionMatch?.[1]) return oneLine(decisionMatch[1], 240);

  return 'Whether one decision earns surfacing in this decide run.';
}

function extractRead(request) {
  const evidenceIds = extractEvidenceIds(request.user);
  return [
    'life-constitution.md',
    'stations/decide.md',
    'recent substrate context',
    ...evidenceIds,
  ];
}

function extractEvidenceIds(text) {
  const ids = new Set();
  const source = stringValue(text);

  for (const match of source.matchAll(/<<<\s+(?:Exposure|SelfPattern|FootprintSample):([^>\s]+)\s+>>>/g)) {
    ids.add(match[1]);
  }
  for (const match of source.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
    ids.add(match[1]);
  }

  return [...ids].slice(0, 12);
}

function inferReversibility(text) {
  const lower = text.toLowerCase();
  if (/\b(irreversible|permanent|delete|destroy|cannot undo|no reliable undo)\b/.test(lower)) {
    return 'irreversible';
  }
  if (/\b(message|send|publish|post|trade|buy|sell|account|book|order|cancel|external)\b/.test(lower)) {
    return 'external-cancelable';
  }
  if (/\b(apologize|refund|repair|compensate|relationship|standing)\b/.test(lower)) {
    return 'external-compensable';
  }
  if (/\b(commitment|identity|protocol|habit|training|sleep schedule)\b/.test(lower)) {
    return 'internal-compensable';
  }
  return 'internal-revertible';
}

function undoForReversibility(reversibility) {
  switch (reversibility) {
    case 'irreversible':
      return 'Do not perform the irreversible act unless the human explicitly accepts the blast radius; no reliable undo exists.';
    case 'external-cancelable':
      return 'Cancel the external step before it takes effect, or stage a compensating reversal for the human.';
    case 'external-compensable':
      return 'Compensate externally with a correction, apology, refund, or repair path chosen by the human.';
    case 'internal-compensable':
      return 'Run a short reversal experiment and compensate with the prior internal pattern if the signal worsens.';
    case 'internal-revertible':
    default:
      return 'Drop the staged recommendation and return to the prior local state.';
  }
}

function boardConfidence(auditor, da) {
  const convergenceLift = Math.min(0.2, auditor.convergence_points.length * 0.04);
  const daPenalty = da.lowConfidence ? 0.1 : 0;
  const landedPenalty = auditor.da_landed ? 0.05 : 0;
  return clamp(0.45 + convergenceLift - daPenalty - landedPenalty, 0.2, 0.75);
}

function isActionableConsider(value) {
  const text = stringValue(value);
  if (!text) return false;
  return !/\b(insufficient data|no recommendation|nothing earns attention|stay silent|silence)\b/i.test(text);
}

function nextStep(consider) {
  return isActionableConsider(consider)
    ? 'stage this recommendation for human review; do not auto-act'
    : 'stay silent until missing evidence changes';
}

function trimContext(value) {
  const text = stringValue(value);
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated for board pass]`;
}

async function withTimeout(operation, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`board internal call timed out: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function baseLabel(request) {
  return request.label || 'cs-k:decide';
}

function requiredStringField(value, field, label) {
  const text = stringValue(value?.[field]).trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item).trim()).filter(Boolean);
}

function oneLine(value, max = 500) {
  const text = stringValue(value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}...`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
