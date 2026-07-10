import {
  normalizeReversibilityClass,
  reversibilityRequiresHumanGate,
} from './substrate.mjs';

const TAG_GATE_HUMAN = '[gate:human]';
const TAG_ADVISE = '[advise]';
const TAG_AUTO = '[auto]';

export const CAPABILITY_TAGS = Object.freeze([
  TAG_GATE_HUMAN,
  TAG_ADVISE,
  TAG_AUTO,
]);

export const AUTO_ALLOWLIST = Object.freeze([]);

const RISK_ALIASES = Object.freeze({
  low: 'low-stakes',
  'low-stakes': 'low-stakes',
  low_stakes: 'low-stakes',
  'low stakes': 'low-stakes',
  consequential: 'consequential',
});

export function governNextAction(stagedRecommendation) {
  if (!isPlainObject(stagedRecommendation)) {
    return inertText();
  }

  const target = requiredText(stagedRecommendation.target);
  const risk = normalizeRisk(stagedRecommendation.risk);
  const reversibilityClass = normalizeReversibilityClass(
    stagedRecommendation.reversibilityClass ??
      stagedRecommendation['reversibility-class'] ??
      stagedRecommendation.reversibility,
  );
  const authority = requiredText(stagedRecommendation.authority);

  if (!target || !risk || !reversibilityClass || !authority) {
    return inertText(stagedRecommendation);
  }

  const tag = classifyTag({
    risk,
    reversibilityClass,
    target,
    requestedTag: stagedRecommendation.tag,
  });

  return Object.freeze({
    kind: 'NextAction',
    schemaVersion: 1,
    target,
    risk,
    'reversibility-class': reversibilityClass,
    authority,
    tag,
    status: tag === TAG_GATE_HUMAN ? 'requires-human-gate' : 'advisory-only',
    unattended: false,
  });
}

export function isNextAction(value) {
  if (!isPlainObject(value) || value.kind !== 'NextAction') return false;
  if (value.tag === TAG_AUTO) return autoAllowed(value.target);
  return value.tag === TAG_GATE_HUMAN || value.tag === TAG_ADVISE;
}

export function classifyTag({
  risk,
  reversibilityClass,
  target,
  requestedTag,
} = {}) {
  const normalizedRisk = normalizeRisk(risk) ?? requiredText(risk);
  const normalizedReversibilityClass =
    normalizeReversibilityClass(reversibilityClass);
  const requiresHumanGate =
    normalizedRisk === 'consequential' ||
    !normalizedReversibilityClass ||
    reversibilityRequiresHumanGate(normalizedReversibilityClass);

  if (
    requiredText(requestedTag) === TAG_AUTO &&
    autoAllowed(target) &&
    !requiresHumanGate
  ) {
    return TAG_AUTO;
  }

  if (requiresHumanGate) {
    return TAG_GATE_HUMAN;
  }

  return TAG_ADVISE;
}

function normalizeRisk(value) {
  const text = requiredText(value);
  if (!text) return undefined;
  return RISK_ALIASES[text.toLowerCase()];
}

function autoAllowed(target) {
  const normalizedTarget = requiredText(target);
  return Boolean(normalizedTarget) &&
    AUTO_ALLOWLIST.length > 0 &&
    AUTO_ALLOWLIST.includes(normalizedTarget);
}

function requiredText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function inertText(stagedRecommendation) {
  const text =
    isPlainObject(stagedRecommendation) &&
    requiredText(stagedRecommendation.recommended ?? stagedRecommendation.decision);
  const suffix = text ? ` ${text}` : '';
  return `Inert text: unvalidated Next-Action.${suffix} A button carries authority weight; confirmation is not authority.`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
