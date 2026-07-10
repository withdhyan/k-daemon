import path from 'node:path';

import {
  COMMIT_TOOL,
  ROOT,
  buildModelRequest,
  clampConfidence,
  commitStationOutput,
  defaultModelCall,
  isPlainObject,
  iso,
  normalizeRisk,
  normalizeVerdict,
  parseFrontmatter,
  readText,
  refuseAutoAction,
  stamp,
  today,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import { governNextAction } from '../next-action.mjs';
import {
  createSubstrateStore,
  normalizeReversibilityClass,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import {
  createGoal,
  listOpenGoals,
} from '../goals/goals.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const STRATEGY_SCHEMA_VERSION = 1;
const DEFAULT_OPEN_GOAL_LIMIT = 6;
const DEFAULT_ACTION_GOAL_TURN_BUDGET = 1;
const OPEN_GOAL_LINE_MAX_CHARS = 240;
const DEGREE_QUESTIONS = Object.freeze([
  'What or who is named directly?',
  'Who immediately gains or loses?',
  'Where does displaced demand, attention, flow, or constraint pressure go?',
  'What narrative or reflexive bid catches?',
  'What breaks if the story is wrong?',
]);

export async function strategize(goal, opts = {}) {
  const normalizedGoal = requiredString(goal, 'goal');
  const dataDir = path.resolve(opts.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? createSubstrateStore({ dataDir, now });
  const singleCall = opts.modelCall ?? defaultModelCall;
  const stationPrompt = await loadStrategyPrompt(opts.promptPath);
  const constitution = await readText(path.join(ROOT, 'life-constitution.md'));
  const openGoals = await listOpenGoals({
    dataDir,
    limit: opts.openGoalLimit ?? DEFAULT_OPEN_GOAL_LIMIT,
  });
  const request = buildModelRequest({
    station: 'strategize',
    stationPrompt,
    constitution,
    context: strategyContext(normalizedGoal, openGoals),
    input: normalizedGoal,
    now,
  });

  if (request.tool.name !== COMMIT_TOOL.name) {
    throw new Error('strategize must use the commit_loop_output tool');
  }

  const rawOutput = await singleCall(request);
  const normalized = normalizeStrategyOutput(rawOutput, { goal: normalizedGoal, now });
  const relPath = await writeUniqueDataJson(
    dataDir,
    'strategies',
    stamp(now),
    normalized.artifact,
  );
  const mutations = [
    { op: 'write', path: path.join('data', relPath), kind: normalized.artifact.kind },
  ];

  let nextAction;
  let objectiveGoal;
  if (normalized.actionableNextStep) {
    nextAction = governNextAction(normalized.actionableNextStep);
    if (isPlainObject(nextAction)) {
      objectiveGoal = await createGoal(normalized.actionableNextStep.target, {
        dataDir,
        now,
        turnBudget: actionableTurnBudget(normalized.actionableNextStep, opts),
        state: {
          source: 'strategize',
          strategyGoal: normalizedGoal,
          strategyCreatedAt: normalized.artifact.createdAt,
        },
      });
      mutations.push({
        op: 'write',
        path: path.join('data', 'goals'),
        kind: 'Goal',
        id: objectiveGoal.goalId,
      });
      const decisionMutations = await commitStationOutput(
        'decide',
        {
          summary: `Strategy next step: ${normalized.actionableNextStep.target}`,
          verdict: 'recommend',
          recommendation: recommendationFromAction(
            normalized.actionableNextStep,
            normalized.artifact,
          ),
        },
        { dataDir, store, now },
      );
      mutations.push(...decisionMutations);
    }
  }

  return Object.freeze({
    capability: 'strategize',
    label: request.label,
    model: request.model,
    output: normalized.output,
    artifact: normalized.artifact,
    nextAction,
    ...(objectiveGoal ? { objectiveGoal } : {}),
    mutations,
  });
}

function normalizeStrategyOutput(rawOutput, { goal, now }) {
  if (!isPlainObject(rawOutput)) {
    throw new Error('strategy output must be an object');
  }
  refuseAutoAction(rawOutput);

  const strategy = isPlainObject(rawOutput.strategy) ? rawOutput.strategy : rawOutput;
  refuseAutoAction(strategy);

  const summary = optionalString(rawOutput.summary) ?? optionalString(strategy.summary) ?? 'Strategy artifact.';
  const verdict = normalizeVerdict(rawOutput.verdict ?? strategy.verdict);
  const degreeMap = normalizeDegreeMap(strategy.degreeMap ?? strategy['degree-map']);
  const filters = normalizeFilters(strategy.filters);
  const evidenceLedger = normalizeObjectArray(
    strategy.evidenceLedger ?? strategy['evidence-ledger'],
    'strategy.evidenceLedger',
    normalizeEvidenceEntry,
  );
  const goalArithmetic = normalizeGoalArithmetic(
    strategy.goalArithmetic ?? strategy['goal-arithmetic'],
  );
  const bets = normalizeObjectArray(
    strategy.bets ?? strategy.candidateBets ?? strategy['candidate-bets'] ?? [],
    'strategy.bets',
    normalizeBet,
    { allowEmpty: true },
  );
  const antiFooling = normalizeAntiFooling(
    strategy.antiFooling ?? strategy['anti-fooling'],
  );
  const workstreams = normalizeObjectArray(
    strategy.workstreams,
    'strategy.workstreams',
    normalizeWorkstream,
  );
  const actionableNextStep = normalizeActionableNextStep(
    strategy.actionableNextStep ?? strategy['actionable-next-step'] ?? strategy.nextAction,
  );

  const artifact = {
    kind: 'StrategyArtifact',
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    goal,
    date: today(now),
    createdAt: iso(now),
    summary,
    verdict,
    degreeMap,
    filters,
    evidenceLedger,
    goalArithmetic,
    bets,
    antiFooling,
    workstreams,
    ...(actionableNextStep ? { actionableNextStep } : {}),
  };

  return {
    output: {
      summary,
      verdict,
      strategy: artifact,
    },
    artifact,
    actionableNextStep,
  };
}

function normalizeDegreeMap(value) {
  const entries = Array.isArray(value)
    ? value
    : [0, 1, 2, 3, 4].map((degree) =>
        value?.[degree] ??
        value?.[`degree${degree}`] ??
        value?.[`degree_${degree}`] ??
        value?.[`degree-${degree}`],
      );

  if (!Array.isArray(entries) || entries.length < 5) {
    throw new Error('strategy.degreeMap must contain degrees 0 through 4');
  }

  return [0, 1, 2, 3, 4].map((degree) => {
    const entry = entries.find((candidate) => Number(candidate?.degree) === degree) ?? entries[degree];
    if (!isPlainObject(entry)) {
      throw new Error(`strategy.degreeMap[${degree}] must be an object`);
    }

    return {
      degree,
      question: optionalString(entry.question) ?? DEGREE_QUESTIONS[degree],
      answer: requiredString(
        entry.answer ?? entry.analysis ?? entry.thesis,
        `strategy.degreeMap[${degree}].answer`,
      ),
      evidenceIds: normalizeStringArray(entry.evidenceIds ?? entry.evidence ?? [], {
        field: `strategy.degreeMap[${degree}].evidenceIds`,
        allowEmpty: true,
      }),
    };
  });
}

function normalizeFilters(value) {
  if (!isPlainObject(value)) {
    throw new Error('strategy.filters must be an object');
  }

  return {
    expressible: normalizeFilter(value.expressible, 'strategy.filters.expressible'),
    notPricedIn: normalizeFilter(
      value.notPricedIn ?? value.not_priced_in ?? value['not-priced-in'],
      'strategy.filters.notPricedIn',
    ),
    asymmetry: normalizeFilter(value.asymmetry, 'strategy.filters.asymmetry'),
  };
}

function normalizeFilter(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object`);
  }

  return {
    pass: Boolean(value.pass ?? value.passes),
    rationale: requiredString(value.rationale ?? value.reason, `${field}.rationale`),
    evidenceIds: normalizeStringArray(value.evidenceIds ?? value.evidence ?? [], {
      field: `${field}.evidenceIds`,
      allowEmpty: true,
    }),
    ...(optionalString(value.expression ?? value.instrument ?? value.venue)
      ? { expression: optionalString(value.expression ?? value.instrument ?? value.venue) }
      : {}),
    ...(optionalString(value.ratio ?? value.asymmetryRatio)
      ? { ratio: optionalString(value.ratio ?? value.asymmetryRatio) }
      : {}),
  };
}

function normalizeEvidenceEntry(entry, index) {
  return {
    claim: requiredString(entry.claim, `strategy.evidenceLedger[${index}].claim`),
    supports: normalizeStringArray(entry.supports ?? entry.supporting ?? [], {
      field: `strategy.evidenceLedger[${index}].supports`,
      allowEmpty: true,
    }),
    counters: normalizeStringArray(entry.counters ?? entry.counterevidence ?? entry.against ?? [], {
      field: `strategy.evidenceLedger[${index}].counters`,
      allowEmpty: true,
    }),
    confidence: clampConfidence(entry.confidence ?? 0),
  };
}

function normalizeGoalArithmetic(value) {
  if (!isPlainObject(value)) {
    throw new Error('strategy.goalArithmetic must be an object');
  }

  return {
    currentState: requiredString(
      value.currentState ?? value.current ?? value.now,
      'strategy.goalArithmetic.currentState',
    ),
    desiredState: requiredString(
      value.desiredState ?? value.target ?? value.goal,
      'strategy.goalArithmetic.desiredState',
    ),
    gap: requiredString(value.gap, 'strategy.goalArithmetic.gap'),
    deadline: requiredString(value.deadline ?? value.horizon, 'strategy.goalArithmetic.deadline'),
    constraints: normalizeStringArray(value.constraints ?? [], {
      field: 'strategy.goalArithmetic.constraints',
      allowEmpty: true,
    }),
    forcingFunction: requiredString(
      value.forcingFunction ?? value['forcing-function'] ?? value.cadence,
      'strategy.goalArithmetic.forcingFunction',
    ),
  };
}

function normalizeBet(entry, index) {
  return {
    claim: requiredString(entry.claim, `strategy.bets[${index}].claim`),
    direction: optionalString(entry.direction) ?? 'parked',
    magnitude: optionalString(entry.magnitude) ?? 'unmeasured',
    deadline: optionalString(entry.deadline ?? entry.horizon) ?? 'unset',
    expression: optionalString(entry.expression ?? entry.instrument) ?? 'unexpressed',
    carry: optionalString(entry.carry) ?? 'unknown',
    resolutionRisk: optionalString(entry.resolutionRisk ?? entry['resolution-risk']) ?? 'unknown',
    asymmetry: optionalString(entry.asymmetry) ?? 'unknown',
    status: optionalString(entry.status) ?? 'draft',
  };
}

function normalizeAntiFooling(value) {
  if (!isPlainObject(value)) {
    throw new Error('strategy.antiFooling must be an object');
  }

  const killCriteria = normalizeStringArray(value.killCriteria ?? value['kill-criteria'], {
    field: 'strategy.antiFooling.killCriteria',
  });

  return {
    disconfirmers: normalizeStringArray(value.disconfirmers ?? [], {
      field: 'strategy.antiFooling.disconfirmers',
      allowEmpty: true,
    }),
    failureModes: normalizeStringArray(value.failureModes ?? value['failure-modes'] ?? [], {
      field: 'strategy.antiFooling.failureModes',
      allowEmpty: true,
    }),
    killCriteria,
  };
}

function normalizeWorkstream(entry, index) {
  return {
    name: requiredString(entry.name, `strategy.workstreams[${index}].name`),
    objective: requiredString(entry.objective ?? entry.goal, `strategy.workstreams[${index}].objective`),
    nextSteps: normalizeStringArray(entry.nextSteps ?? entry['next-steps'], {
      field: `strategy.workstreams[${index}].nextSteps`,
    }),
    dependencies: normalizeStringArray(entry.dependencies ?? [], {
      field: `strategy.workstreams[${index}].dependencies`,
      allowEmpty: true,
    }),
    stopCondition: requiredString(
      entry.stopCondition ?? entry['stop-condition'] ?? entry.killCriterion,
      `strategy.workstreams[${index}].stopCondition`,
    ),
  };
}

function normalizeActionableNextStep(value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (!isPlainObject(value)) {
    throw new Error('strategy.actionableNextStep must be an object when present');
  }
  refuseAutoAction(value);

  const reversibilityClass = normalizeReversibility(
    value.reversibilityClass ?? value['reversibility-class'] ?? value.reversibility,
  );
  const risk = normalizeRisk(value.risk) ?? 'consequential';
  const turnBudget = positiveIntegerOrUndefined(value.turnBudget ?? value.turns);

  return {
    target: requiredString(
      value.target ?? value.recommended ?? value.next,
      'strategy.actionableNextStep.target',
    ),
    risk,
    reversibilityClass,
    authority: requiredString(value.authority ?? 'human', 'strategy.actionableNextStep.authority'),
    reason: requiredString(value.reason, 'strategy.actionableNextStep.reason'),
    undo: requiredString(value.undo, 'strategy.actionableNextStep.undo'),
    evidenceIds: normalizeStringArray(value.evidenceIds ?? value.evidence ?? [], {
      field: 'strategy.actionableNextStep.evidenceIds',
      allowEmpty: true,
    }),
    confidence: clampConfidence(value.confidence ?? 0),
    ...(turnBudget !== undefined ? { turnBudget } : {}),
  };
}

function recommendationFromAction(action, artifact) {
  return {
    decision: `Whether to take the next step for: ${artifact.goal}`,
    recommended: action.target,
    reason: action.reason,
    risk: action.risk,
    reversibility: action.reversibilityClass,
    undo: action.undo,
    evidenceIds: action.evidenceIds,
    confidence: action.confidence,
  };
}

function normalizeObjectArray(value, field, normalizer, options = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    return normalizer(entry, index);
  });
}

function normalizeStringArray(value, { field, allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${field ?? 'value'} must be an array`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${field ?? 'value'} must not be empty`);
  }

  return [...new Set(value.map((item) => requiredString(item, `${field ?? 'value'} item`)))];
}

function normalizeReversibility(value) {
  const normalized = normalizeReversibilityClass(value);
  if (normalized) return normalized;
  requiredString(value, 'strategy.actionableNextStep.reversibilityClass');
  throw new Error(`invalid reversibilityClass: ${value}`);
}

function positiveIntegerOrUndefined(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`strategy.actionableNextStep.turnBudget must be a positive integer`);
  }
  return number;
}

function strategyContext(goal, openGoals = []) {
  return [
    '## Strategy request',
    goal,
    '## Open objectives',
    formatOpenGoals(openGoals),
    '## Required output reminder',
    'Persistable strategy only. Include a 0->4 degreeMap, the three filters, evidenceLedger, goalArithmetic, bets, antiFooling.killCriteria, and workstreams.',
    'Omit actionableNextStep unless there is a concrete next step for a human-owned LoopRecommendation.',
  ].join('\n');
}

function formatOpenGoals(openGoals) {
  if (!Array.isArray(openGoals) || openGoals.length === 0) return '(none)';
  return openGoals
    .slice(0, DEFAULT_OPEN_GOAL_LIMIT)
    .map((goal, index) => {
      const remaining = Number.isInteger(goal.state?.turnsRemaining)
        ? ` turnsRemaining=${goal.state.turnsRemaining}`
        : '';
      return boundOpenGoalLine(`${index + 1}. ${goal.objective} [${goal.status}${remaining}]`);
    })
    .join('\n');
}

function boundOpenGoalLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= OPEN_GOAL_LINE_MAX_CHARS) return text;
  return `${text.slice(0, OPEN_GOAL_LINE_MAX_CHARS - 3)}...`;
}

function actionableTurnBudget(action, opts) {
  const raw = action.turnBudget ?? action.turns ?? opts.goalTurnBudget ?? DEFAULT_ACTION_GOAL_TURN_BUDGET;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_ACTION_GOAL_TURN_BUDGET;
}

async function loadStrategyPrompt(promptPath) {
  const source = await readText(promptPath ?? path.join(ROOT, 'prompts', 'strategy.md'));
  return parseFrontmatter(source);
}
