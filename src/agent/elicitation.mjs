import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { loadSoulSnapshot } from './soul.mjs';
import { atomicWriteJson } from './routines.mjs';

export const VALUE_PROBE_REVIEW_CARD_TYPE = 'value-probe';
export const VALUE_PROBE_SET_KIND = 'ValueProbeSet';
export const VALUE_PROBE_KIND = 'ValueProbe';
export const VALUE_ANCHOR_KIND = 'ValueAnchor';
export const VALUE_ANCHORS_DIR = path.join('elicitation', 'value-anchors');
export const CADENCE_VALUE_PROBE_ANSWERS_PATH = '/api/cadence/value-probes/answers';
export const MAX_WEEKLY_VALUE_PROBES = 3;

const USER_MODEL_REL_PATHS = Object.freeze([
  path.join('substrate', 'user-model.md'),
  path.join('substrate', 'model-of-founder.md'),
  path.join('substrate', 'life-context.md'),
  'user-model.md',
  'life-context.md',
]);

const VALUE_PROBE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'attention-freedom-vs-instrumented-loop',
    axis: 'attention-economics',
    question: 'when both are true, which is more you this week?',
    left: {
      id: 'free-attention',
      label: 'free attention by staying out of the way',
      value: 'attention_freedom',
    },
    right: {
      id: 'instrument-loop',
      label: 'instrument the loop so future decisions get lighter',
      value: 'instrumented_loop',
    },
    cues: ['attention', 'free', 'loop', 'tws', 'measure', 'eval', 'instrument'],
  }),
  Object.freeze({
    id: 'local-sovereignty-vs-frontier-leverage',
    axis: 'sovereignty-and-leverage',
    question: 'when they trade off, which is more you this week?',
    left: {
      id: 'keep-local',
      label: 'keep judgement and private context local',
      value: 'local_sovereignty',
    },
    right: {
      id: 'use-frontier-leverage',
      label: 'use explicit frontier help when leverage is worth it',
      value: 'frontier_leverage',
    },
    cues: ['local', 'sovereign', 'private', 'frontier', 'opt-in', 'tool', 'external'],
  }),
  Object.freeze({
    id: 'silence-default-vs-decision-surfacing',
    axis: 'proactivity-boundary',
    question: 'if only one wins, which is more you this week?',
    left: {
      id: 'silence-default',
      label: 'stay silent unless the signal has earned attention',
      value: 'silence_default',
    },
    right: {
      id: 'surface-decision',
      label: 'surface a decision before attention leaks away',
      value: 'decision_surfacing',
    },
    cues: ['silence', 'advisory', 'nudge', 'decision', 'de-load', 'attention', 'cadence'],
  }),
  Object.freeze({
    id: 'lived-proof-vs-rich-artifact',
    axis: 'proof-style',
    question: 'for a close call, which is more you this week?',
    left: {
      id: 'lived-proof',
      label: 'trust lived outcomes over polished artifacts',
      value: 'lived_proof',
    },
    right: {
      id: 'preserve-richness',
      label: 'preserve rich artifacts so intent stays recoverable',
      value: 'rich_artifact',
    },
    cues: ['lived', 'footprint', 'artifact', 'richness', 'preserve', 'intent', 'recover'],
  }),
  Object.freeze({
    id: 'supersession-history-vs-current-simplicity',
    axis: 'memory-shape',
    question: 'when the system must choose, which is more you this week?',
    left: {
      id: 'keep-history',
      label: 'keep auditable history and contradiction visible',
      value: 'auditable_supersession',
    },
    right: {
      id: 'simplify-current',
      label: 'simplify the current model so action is easier',
      value: 'current_simplicity',
    },
    cues: ['supersession', 'history', 'contradiction', 'auditable', 'simple', 'model', 'mutation'],
  }),
  Object.freeze({
    id: 'embodied-cadence-vs-open-exploration',
    axis: 'attention-placement',
    question: 'in practice, which is more you this week?',
    left: {
      id: 'embodied-cadence',
      label: 'anchor choices in cadence, body, and blocks',
      value: 'embodied_cadence',
    },
    right: {
      id: 'open-exploration',
      label: 'protect open exploration before structure hardens',
      value: 'open_exploration',
    },
    cues: ['cadence', 'body', 'block', 'bandish', 'exploration', 'research', 'thread'],
  }),
  Object.freeze({
    id: 'human-gate-vs-bounded-autonomy',
    axis: 'agency-boundary',
    question: 'if k needs a default, which is more you this week?',
    left: {
      id: 'human-gate',
      label: 'keep consequential steps human-gated',
      value: 'human_gate',
    },
    right: {
      id: 'bounded-autonomy',
      label: 'grant bounded autonomy after proof is visible',
      value: 'bounded_autonomy',
    },
    cues: ['gate', 'human', 'consequential', 'autonomy', 'proof', 'allowlist', 'irreversible'],
  }),
]);

export async function buildValueProbeReviewCard(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = dateFrom(resolveNow(options.now));
  const date = dayKey(options.date ?? now);
  const weekStart = weekStartKey(options.weekStart ?? date);
  const weekEnd = dayKey(new Date(Date.parse(`${weekStart}T00:00:00.000Z`) + (6 * 24 * 60 * 60 * 1000)));
  const sources = await collectElicitationSources({
    dataDir,
    store: options.substrateStore ?? options.store,
  });
  const maxProbes = Math.min(MAX_WEEKLY_VALUE_PROBES, positiveInt(options.maxProbes ?? MAX_WEEKLY_VALUE_PROBES));
  const probes = selectValueProbes({
    sources,
    weekStart,
    maxProbes,
  });
  const valueProbes = {
    kind: VALUE_PROBE_SET_KIND,
    schemaVersion: 1,
    weekStart,
    weekEnd,
    maxProbes,
    count: probes.length,
    answeredCount: 0,
    sourceContext: projectSourceContext(sources),
    antiBarnum: antiBarnumContract(),
    probes,
    answerAction: {
      type: 'elicitation.value-probe.answer',
      method: 'POST',
      path: CADENCE_VALUE_PROBE_ANSWERS_PATH,
      body: {
        cardId: `review-${date}-${VALUE_PROBE_REVIEW_CARD_TYPE}`,
        answers: [],
      },
    },
  };

  return stripUndefined({
    id: `review-${date}-${VALUE_PROBE_REVIEW_CARD_TYPE}`,
    type: VALUE_PROBE_REVIEW_CARD_TYPE,
    date,
    title: 'value probes',
    status: 'open',
    sections: {
      valueProbes: {
        id: 'valueProbes',
        label: 'value probes',
        weekStart,
        weekEnd,
        probes,
        answeredCount: 0,
      },
    },
    valueProbes,
    generatedAt: iso(now),
    createdAt: iso(now),
    updatedAt: iso(now),
  });
}

export async function persistValueProbeAnswers(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = dateFrom(resolveNow(options.now));
  const card = normalizeValueProbeCard(options.card);
  const answers = normalizeValueProbeAnswers(options.answers);
  const probesById = new Map(card.valueProbes.probes.map((probe) => [probe.id, probe]));
  const anchors = [];
  let createdCount = 0;

  for (const answer of answers) {
    const probe = probesById.get(answer.probeId);
    if (!probe) throw new Error(`unknown value probe: ${answer.probeId}`);
    const selected = probe.options.find((option) => option.id === answer.selectedOptionId);
    if (!selected) throw new Error(`unknown value probe option: ${answer.selectedOptionId}`);
    const rejected = probe.options.find((option) => option.id !== selected.id);
    const write = await writeValueAnchor({
      dataDir,
      now,
      card,
      probe,
      selected,
      rejected,
    });
    anchors.push(write.anchor);
    if (write.created) createdCount += 1;
  }

  return deepFreeze({
    ok: true,
    cardId: card.id,
    date: card.date,
    weekStart: card.valueProbes.weekStart,
    count: anchors.length,
    createdCount,
    anchors,
  });
}

export async function listValueAnchors(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const cardId = optionalString(options.cardId);
  const probeId = optionalString(options.probeId);
  const records = await listJsonRecords(dataDir, VALUE_ANCHORS_DIR);
  return records
    .map((entry) => normalizeValueAnchor(entry.data))
    .filter((anchor) => !cardId || anchor.cardId === cardId)
    .filter((anchor) => !probeId || anchor.probeId === probeId)
    .sort(compareValueAnchors)
    .map(clone);
}

export async function attachValueProbeAnchors(card, options = {}) {
  if (card?.type !== VALUE_PROBE_REVIEW_CARD_TYPE || !isPlainObject(card.valueProbes)) return card;
  const dataDir = requiredDataDir(options.dataDir);
  const anchors = await listValueAnchors({ dataDir, cardId: card.id });
  const anchorsByProbeId = new Map(anchors.map((anchor) => [anchor.probeId, anchor]));
  const probes = Array.isArray(card.valueProbes.probes)
    ? card.valueProbes.probes.map((probe) => attachProbeAnswer(probe, anchorsByProbeId.get(probe.id)))
    : [];
  const answeredCount = probes.filter((probe) => probe.answer).length;
  const valueProbes = {
    ...card.valueProbes,
    probes,
    answeredCount,
    anchors: anchors.map(projectValueAnchorForCard),
  };

  return deepFreeze(stripUndefined({
    ...card,
    valueProbes,
    sections: {
      ...card.sections,
      valueProbes: {
        ...(isPlainObject(card.sections?.valueProbes) ? card.sections.valueProbes : {}),
        probes,
        answeredCount,
      },
    },
  }));
}

export async function collectElicitationSources(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const [soul, userModelArtifacts, substrateArtifacts] = await Promise.all([
    loadSoulSnapshot({
      dataDir,
      createIfMissing: false,
    }),
    readUserModelTextArtifacts(dataDir),
    readSubstrateModelArtifacts({
      dataDir,
      store: options.store,
    }),
  ]);
  const artifacts = [
    {
      type: 'soul',
      relPath: soul.relPath,
      contentHash: soul.contentHash,
      text: soul.text,
    },
    ...userModelArtifacts,
    ...substrateArtifacts,
  ].filter((artifact) => optionalString(artifact.text));
  const combinedText = artifacts.map((artifact) => artifact.text).join('\n\n');

  return deepFreeze({
    kind: 'ElicitationSourceContext',
    schemaVersion: 1,
    artifacts,
    combinedText,
    contentHash: sha256(combinedText),
  });
}

function selectValueProbes({ sources, weekStart, maxProbes }) {
  const text = sources.combinedText.toLowerCase();
  const salt = `${weekStart}:${sources.contentHash}`;
  return VALUE_PROBE_TEMPLATES
    .map((template) => ({
      template,
      score: scoreTemplate(template, text),
      tieBreak: sha256(`${salt}:${template.id}`),
    }))
    .sort((a, b) =>
      b.score - a.score ||
      a.tieBreak.localeCompare(b.tieBreak) ||
      a.template.id.localeCompare(b.template.id))
    .slice(0, maxProbes)
    .map(({ template }, index) => valueProbeFromTemplate(template, {
      index,
      weekStart,
      sourceHash: sources.contentHash,
      evidence: sourceEvidenceForTemplate(template, sources),
    }));
}

function valueProbeFromTemplate(template, { index, weekStart, sourceHash, evidence }) {
  const id = `vp-${weekStart}-${template.id}`;
  const options = [
    { ...template.left, position: 'left' },
    { ...template.right, position: 'right' },
  ];
  return deepFreeze(stripUndefined({
    id,
    kind: VALUE_PROBE_KIND,
    schemaVersion: 1,
    ordinal: index + 1,
    weekStart,
    axis: template.axis,
    prompt: template.question,
    question: template.question,
    shape: 'which-is-more-you',
    forcedChoice: true,
    options,
    sourceHash,
    sourceEvidence: evidence,
    antiBarnum: antiBarnumContract(),
  }));
}

function scoreTemplate(template, text) {
  let score = 0;
  for (const cue of template.cues) {
    const pattern = new RegExp(escapeRegExp(cue.toLowerCase()), 'g');
    score += (text.match(pattern) ?? []).length;
  }
  return score;
}

function sourceEvidenceForTemplate(template, sources) {
  const evidence = [];
  for (const artifact of sources.artifacts) {
    for (const cue of template.cues) {
      const snippet = snippetAroundCue(artifact.text, cue);
      if (!snippet) continue;
      evidence.push(stripUndefined({
        sourceType: artifact.type,
        relPath: artifact.relPath,
        recordKind: artifact.recordKind,
        recordId: artifact.recordId,
        cue,
        snippet,
      }));
      break;
    }
    if (evidence.length >= 2) break;
  }
  return evidence;
}

async function writeValueAnchor({ dataDir, now, card, probe, selected, rejected }) {
  const id = valueAnchorId(card.id, probe.id);
  const relPath = path.join(VALUE_ANCHORS_DIR, `${id}.json`);
  const file = safeDataPath(dataDir, relPath);
  const existing = await readJsonIfExists(file);
  if (existing) {
    const anchor = normalizeValueAnchor(existing);
    if (anchor.selectedOptionId !== selected.id) {
      throw new Error(`value anchor already recorded for probe: ${probe.id}`);
    }
    return {
      created: false,
      anchor,
      path: path.join('data', relPath),
    };
  }

  const anchor = normalizeValueAnchor(stripUndefined({
    id,
    kind: VALUE_ANCHOR_KIND,
    schemaVersion: 1,
    cardId: card.id,
    probeId: probe.id,
    date: card.date,
    weekStart: card.valueProbes.weekStart,
    weekEnd: card.valueProbes.weekEnd,
    axis: probe.axis,
    prompt: probe.prompt,
    selectedOptionId: selected.id,
    selectedLabel: selected.label,
    selectedValue: selected.value,
    rejectedOptionId: rejected?.id,
    rejectedLabel: rejected?.label,
    rejectedValue: rejected?.value,
    sourceProbeHash: probe.sourceHash,
    sourceEvidence: probe.sourceEvidence,
    antiBarnum: probe.antiBarnum ?? antiBarnumContract(),
    evalLayer: 3,
    evalDesignLayer: 'elicitation',
    evalSignal: 'forced-choice-value-anchor',
    eval: {
      design: 'eval-design',
      layer: 3,
      signal: 'forced-choice-value-anchor',
    },
    provenance: {
      surface: 'cadence.review-card',
      lane: 'deliberate',
      routine: 'weekly-value-probes',
    },
    recordedAt: iso(now),
    createdAt: iso(now),
  }));
  await atomicWriteJson(file, anchor);
  return {
    created: true,
    anchor,
    path: path.join('data', relPath),
  };
}

function normalizeValueAnchor(input) {
  if (!isPlainObject(input)) throw new Error('value anchor must be an object');
  const id = assertRecordId(input.id, 'value anchor id');
  return deepFreeze(stripUndefined({
    id,
    kind: optionalString(input.kind) ?? VALUE_ANCHOR_KIND,
    schemaVersion: Number(input.schemaVersion ?? 1),
    cardId: assertRecordId(input.cardId, 'cardId'),
    probeId: assertRecordId(input.probeId, 'probeId'),
    date: dayKey(input.date),
    weekStart: dayKey(input.weekStart),
    weekEnd: dayKey(input.weekEnd),
    axis: optionalString(input.axis),
    prompt: optionalString(input.prompt),
    selectedOptionId: assertRecordId(input.selectedOptionId, 'selectedOptionId'),
    selectedLabel: optionalString(input.selectedLabel),
    selectedValue: optionalString(input.selectedValue),
    rejectedOptionId: optionalString(input.rejectedOptionId),
    rejectedLabel: optionalString(input.rejectedLabel),
    rejectedValue: optionalString(input.rejectedValue),
    sourceProbeHash: optionalString(input.sourceProbeHash),
    sourceEvidence: Array.isArray(input.sourceEvidence) ? input.sourceEvidence : undefined,
    antiBarnum: isPlainObject(input.antiBarnum) ? input.antiBarnum : antiBarnumContract(),
    evalLayer: Number(input.evalLayer ?? input.eval?.layer ?? 3),
    evalDesignLayer: optionalString(input.evalDesignLayer) ?? 'elicitation',
    evalSignal: optionalString(input.evalSignal) ?? 'forced-choice-value-anchor',
    eval: isPlainObject(input.eval)
      ? input.eval
      : {
        design: 'eval-design',
        layer: 3,
        signal: 'forced-choice-value-anchor',
      },
    provenance: isPlainObject(input.provenance) ? input.provenance : undefined,
    recordedAt: normalizeIso(input.recordedAt ?? input.createdAt, 'recordedAt'),
    createdAt: normalizeIso(input.createdAt ?? input.recordedAt, 'createdAt'),
  }));
}

function normalizeValueProbeCard(input) {
  if (!isPlainObject(input)) throw new Error('value probe card is required');
  if (input.type !== VALUE_PROBE_REVIEW_CARD_TYPE) throw new Error('card is not a value-probe card');
  if (!isPlainObject(input.valueProbes)) throw new Error('card.valueProbes is required');
  if (!Array.isArray(input.valueProbes.probes)) throw new Error('card.valueProbes.probes is required');
  return input;
}

function normalizeValueProbeAnswers(value) {
  if (!Array.isArray(value)) throw new Error('answers must be an array');
  return value.map((answer, index) => {
    if (!isPlainObject(answer)) throw new Error(`answers[${index}] must be an object`);
    return {
      probeId: assertRecordId(answer.probeId ?? answer.id, `answers[${index}].probeId`),
      selectedOptionId: assertRecordId(
        answer.selectedOptionId ?? answer.optionId ?? answer.selected ?? answer.answer,
        `answers[${index}].selectedOptionId`,
      ),
    };
  });
}

function attachProbeAnswer(probe, anchor) {
  if (!anchor) return probe;
  return deepFreeze(stripUndefined({
    ...probe,
    answer: {
      anchorId: anchor.id,
      selectedOptionId: anchor.selectedOptionId,
      selectedLabel: anchor.selectedLabel,
      selectedValue: anchor.selectedValue,
      rejectedOptionId: anchor.rejectedOptionId,
      recordedAt: anchor.recordedAt,
    },
  }));
}

function projectValueAnchorForCard(anchor) {
  return stripUndefined({
    id: anchor.id,
    probeId: anchor.probeId,
    selectedOptionId: anchor.selectedOptionId,
    selectedValue: anchor.selectedValue,
    rejectedOptionId: anchor.rejectedOptionId,
    rejectedValue: anchor.rejectedValue,
    evalLayer: anchor.evalLayer,
    recordedAt: anchor.recordedAt,
  });
}

async function readUserModelTextArtifacts(dataDir) {
  const artifacts = [];
  for (const relPath of USER_MODEL_REL_PATHS) {
    const text = await readTextIfExists(safeDataPath(dataDir, relPath));
    if (!optionalString(text)) continue;
    artifacts.push({
      type: 'user-model',
      relPath,
      contentHash: sha256(text),
      text,
    });
  }
  return artifacts;
}

async function readSubstrateModelArtifacts({ dataDir, store }) {
  const substrateStore = store ?? createSubstrateStore({ dataDir });
  const artifacts = [];
  for (const kind of ['SelfPattern', 'LearningRecord']) {
    let records = [];
    try {
      records = await substrateStore.listRecords(kind);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const record of records) {
      const text = recordText(record);
      if (!text) continue;
      artifacts.push({
        type: 'user-model',
        relPath: `substrate/${kind}`,
        recordKind: kind,
        recordId: record.id,
        contentHash: sha256(text),
        text,
      });
    }
  }
  return artifacts;
}

function recordText(record) {
  if (!isPlainObject(record)) return '';
  return [
    record.pattern,
    record.statement,
    record.summary,
    record.title,
    record.lesson,
    record.note,
    record.text,
    record.reason,
    record.evidence,
    record.metadata,
  ].map(textFromValue).filter(Boolean).join('\n');
}

function textFromValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join(' ');
  if (isPlainObject(value)) return Object.values(value).map(textFromValue).filter(Boolean).join(' ');
  return '';
}

function projectSourceContext(sources) {
  const soul = sources.artifacts.find((artifact) => artifact.type === 'soul');
  const userModelArtifacts = sources.artifacts.filter((artifact) => artifact.type === 'user-model');
  return stripUndefined({
    contentHash: sources.contentHash,
    soul: soul
      ? {
        relPath: soul.relPath,
        sha256: soul.contentHash,
      }
      : undefined,
    userModel: {
      artifactCount: userModelArtifacts.length,
      sha256: sha256(userModelArtifacts.map((artifact) => artifact.text).join('\n\n')),
      artifacts: userModelArtifacts.map((artifact) => stripUndefined({
        relPath: artifact.relPath,
        recordKind: artifact.recordKind,
        recordId: artifact.recordId,
        sha256: artifact.contentHash,
      })),
    },
  });
}

function antiBarnumContract() {
  return deepFreeze({
    shape: 'which-is-more-you-pair',
    forcedChoice: true,
    bothOptionsPositive: true,
    rejectsGenericTraitClaim: true,
    noNeutralDefault: true,
  });
}

function snippetAroundCue(text, cue) {
  const compact = optionalString(text)?.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const lower = compact.toLowerCase();
  const index = lower.indexOf(cue.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 70);
  const end = Math.min(compact.length, index + cue.length + 90);
  return compact.slice(start, end).trim();
}

async function listJsonRecords(dataDir, relDir) {
  const dir = safeDataPath(dataDir, relDir);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const relPath = path.join(relDir, entry.name);
    records.push({
      relPath,
      data: JSON.parse(await fs.readFile(safeDataPath(dataDir, relPath), 'utf8')),
    });
  }
  return records;
}

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function compareValueAnchors(a, b) {
  return (
    String(a.weekStart ?? '').localeCompare(String(b.weekStart ?? '')) ||
    String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

function valueAnchorId(cardId, probeId) {
  return `vanchor-${sha256(`${cardId}\n${probeId}`).slice(0, 24)}`;
}

function requiredDataDir(dataDir) {
  return path.resolve(dataDir ?? path.join(process.cwd(), 'data'));
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid positive integer: ${value}`);
  return number;
}

function resolveNow(now) {
  return typeof now === 'function' ? now() : (now ?? new Date());
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function dayKey(value) {
  return dateFrom(value).toISOString().slice(0, 10);
}

function weekStartKey(value) {
  const date = dateFrom(`${dayKey(value)}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return dayKey(date);
}

function normalizeIso(value, field) {
  const text = optionalString(value);
  if (!text) throw new Error(`${field} is required`);
  return iso(dateFrom(text));
}

function assertRecordId(value, field) {
  const id = optionalString(value);
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new Error(`invalid ${field}: ${value}`);
  return id;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
