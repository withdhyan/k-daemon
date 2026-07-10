// KTD9 sensitivity gate for the cs-k agent shell.
//
// SEC-001 (binding): the gate classifies on the ASSEMBLED prompt (system +
// substrate + tool inventory + episodic + user message), NOT the user message
// alone. It is re-run on every reconsult step of the tool loop. If a substrate
// block is present the turn is a SENSITIVE floor regardless of the user text —
// a public question with injected substrate MUST route to the sovereign lane.
//
// The classifier is a CLOSED ENUM (public/internal/personal/sensitive), not a
// wordlist (KTD5 posture): unknown provenance FAILS CLOSED to `sensitive`. It
// never suppresses — it routes. Sovereign-lane failure silences elsewhere
// (SEC-002); this module only decides the lane.

import { optionalString } from '../substrate.mjs';

// Closed enum, ordered least→most sensitive. Anything at or above `personal`
// routes to the sovereign lane; `sensitive` is the crown-jewel floor.
export const SENSITIVITY_CLASSES = Object.freeze([
  'public',
  'internal',
  'personal',
  'sensitive',
]);

const CLASS_RANK = Object.freeze(
  Object.fromEntries(SENSITIVITY_CLASSES.map((value, index) => [value, index])),
);

// The rank at/above which a turn must NOT touch the default frontier.
const SOVEREIGN_FLOOR = CLASS_RANK.personal;

// Provenance markers that force the crown-jewel floor by construction. These
// mirror KTD9's FRONTIER_EXCLUDED kinds and the substrate's private surfaces.
// Matching is case-insensitive on the marker, but the enum is closed — a novel
// marker is not silently treated as public (see `classifyProvenance`).
const SENSITIVE_PROVENANCE_MARKERS = Object.freeze([
  'genomictrait',
  'genome',
  'genomic',
  'biomarker',
  'verbatim-chat',
  'verbatimchat',
  'mind-surface',
  'mindsurface',
  'idea-atom',
  'ideaatom',
  'self-pattern',
  'selfpattern',
  'exposure',
]);

const PERSONAL_PROVENANCE_MARKERS = Object.freeze([
  'substrate',
  'recommendation',
  'decision',
  'life-context',
  'lifecontext',
  'founder',
  'personal',
]);

/**
 * Classify the ASSEMBLED prompt for a single turn (or reconsult step).
 *
 * @param {object} input
 * @param {string} [input.assembledPrompt] - the fully-rendered prompt sent to the model
 *   (system + substrate + tool inventory + episodic + user message). Load-bearing:
 *   pass the WHOLE assembled prompt, not just the user message.
 * @param {boolean} [input.substratePresent] - true if any substrate context is in the prompt.
 *   Substrate-present ⇒ SENSITIVE floor by construction (SEC-001).
 * @param {string[]} [input.provenance] - provenance labels of context blocks merged in.
 *   Unknown provenance FAILS CLOSED to `sensitive`.
 * @returns {{ sensitivity: string, sovereign: boolean, floor: string, reason: string }}
 */
export function classifyTurnSensitivity(input = {}) {
  const substratePresent = input.substratePresent === true;
  const provenance = Array.isArray(input.provenance) ? input.provenance : [];
  const assembledPrompt = optionalString(input.assembledPrompt) ?? '';

  // SEC-001 floor: substrate present ⇒ sensitive, regardless of user message.
  if (substratePresent) {
    return decision('sensitive', 'substrate_block_present');
  }

  // Provenance is authoritative and fail-closed.
  let rank = CLASS_RANK.public;
  let reason = 'no_sensitive_signal';
  for (const label of provenance) {
    const provClass = classifyProvenance(label);
    if (CLASS_RANK[provClass] > rank) {
      rank = CLASS_RANK[provClass];
      reason = `provenance:${provClass}`;
    }
  }

  // Content signals only ever RAISE the floor (never lower it). They are a
  // backstop, not the primary gate — the primary gate is provenance/substrate.
  const contentRank = classifyContentSignals(assembledPrompt);
  if (contentRank > rank) {
    rank = contentRank;
    reason = 'content_signal';
  }

  const sensitivity = SENSITIVITY_CLASSES[rank] ?? 'sensitive';
  return decision(sensitivity, reason);
}

/**
 * Classify a single provenance label. Unknown labels FAIL CLOSED to
 * `sensitive` — a novel provenance is never assumed public.
 */
export function classifyProvenance(label) {
  const normalized = normalize(label);
  if (!normalized) return 'internal';

  if (SENSITIVE_PROVENANCE_MARKERS.some((marker) => normalized.includes(marker))) {
    return 'sensitive';
  }
  if (PERSONAL_PROVENANCE_MARKERS.some((marker) => normalized.includes(marker))) {
    return 'personal';
  }
  if (normalized === 'public' || normalized === 'web' || normalized === 'tool') {
    return 'public';
  }
  if (normalized === 'system' || normalized === 'internal') {
    return 'internal';
  }

  // Unknown provenance is not classifiable against the closed enum → fail closed.
  return 'sensitive';
}

function classifyContentSignals(text) {
  const normalized = normalize(text);
  if (!normalized) return CLASS_RANK.public;

  // Wire-tag markers of injected substrate/private context; a backstop only.
  if (
    SENSITIVE_PROVENANCE_MARKERS.some((marker) => normalized.includes(marker)) ||
    normalized.includes('<substrate') ||
    normalized.includes('substrate context') ||
    normalized.includes('genome') ||
    normalized.includes('genomic')
  ) {
    return CLASS_RANK.sensitive;
  }
  return CLASS_RANK.public;
}

function decision(sensitivity, reason) {
  const rank = CLASS_RANK[sensitivity] ?? CLASS_RANK.sensitive;
  return Object.freeze({
    sensitivity: SENSITIVITY_CLASSES[rank] ?? 'sensitive',
    sovereign: rank >= SOVEREIGN_FLOOR,
    floor: SENSITIVITY_CLASSES[SOVEREIGN_FLOOR],
    reason,
  });
}

function normalize(value) {
  const text = optionalString(value);
  return text ? text.trim().toLowerCase() : '';
}

/** True when a classification must route to the sovereign lane. */
export function requiresSovereignLane(classification) {
  return classification?.sovereign === true;
}
