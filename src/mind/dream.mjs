import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  clampConfidence,
  commitStationOutput,
  iso,
  safeDataPath,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import {
  BUILD_CARD_KIND_SHAPING,
  createBuildCardStore,
  isOpenOrQueuedBuildCard,
} from '../agent/build-cards.mjs';
import {
  ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
  admit as admitAttentionBudget,
  categoryCap as attentionCategoryCap,
} from '../agent/attention-budget.mjs';
import { cosineSimilarity } from '../research/vrsd.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const IDEA_ATOM_DIR = path.join('substrate', 'idea-atoms');
const DECISION_DIR = 'decisions';
export const DREAMING_DIR = 'dreaming';
export const DREAMING_RUN_DIR = path.join(DREAMING_DIR, 'runs');
export const DREAMING_STATE_FILE = path.join(DREAMING_DIR, 'state.json');
export const DREAMING_HIT_RATE_FILE = path.join(DREAMING_DIR, 'hit-rate.json');

const DREAMING_SCHEMA_VERSION = 1;
const DEFAULT_EDGE_BUDGET = 2;
const DEFAULT_MIN_ATTRACTOR_ATOMS = 2;
const DEFAULT_ATTRACTOR_SIMILARITY_THRESHOLD = 0.28;
const DEFAULT_EDGE_SCORE_THRESHOLD = 0.08;
const DEFAULT_DECAY_HALF_LIFE_DAYS = 45;
const DEFAULT_REMOTE_MAX_SIMILARITY = 0.68;
const DEFAULT_REMOTE_MIN_NOVELTY = 0.32;
const DEFAULT_REPEAT_AFTER_DAYS = 30;
const DEFAULT_EXPIRE_AFTER_DAYS = 14;
const MAX_EDGE_HISTORY = 500;
const MAX_TERMS = 6;

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'because',
  'before',
  'being',
  'between',
  'build',
  'could',
  'doing',
  'founder',
  'from',
  'for',
  'have',
  'into',
  'just',
  'keep',
  'make',
  'mind',
  'more',
  'need',
  'needs',
  'only',
  'over',
  'review',
  'should',
  'that',
  'their',
  'there',
  'thing',
  'this',
  'through',
  'with',
  'would',
]);

const LABEL_TRAILING_FILLER = new Set([
  'a',
  'an',
  'and',
  'but',
  'for',
  'from',
  'of',
  'or',
  'the',
  'to',
  'with',
]);

export async function dream(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const nowFn = opts.now ?? (() => new Date());
  const now = dateFrom(nowFn());
  const store = opts.store ?? createSubstrateStore({ dataDir, now: () => now });
  const cardStore = opts.cardStore ?? createBuildCardStore({ dataDir, now: () => now });
  const state = await readDreamingState(dataDir);
  const atoms = liveIdeaAtoms(opts.atoms ?? await readIdeaAtoms(dataDir));
  const docs = buildAtomDocs(atoms, state, now, opts);
  const attractors = slowWaveAttractors(docs, opts);
  const remLinks = remRemoteLinks(attractors, opts);
  const existing = await existingDreamEdges({ dataDir, cardStore, state, now, opts });
  const candidates = rankedDreamEdges({ attractors, remLinks, state, now, opts })
    .filter((edge) => !existing.blockedEdgeKeys.has(edge.edgeKey))
    .filter((edge) => !recentlyEmitted(edge, state, now, opts));
  const emittedEdges = [];
  const queuedEdges = [];
  const attentionBudgetOptions = dreamingAttentionBudgetOptions({ dataDir, now, opts });
  const edgeBudget = attentionCategoryCap(ATTENTION_CATEGORY_DREAMING_EDGE_CARD, attentionBudgetOptions);

  const runBaseName = `dream-${iso(now).replace(/[:.]/g, '-').slice(0, 19)}`;
  for (const edge of candidates) {
    const budget = admitAttentionBudget(dreamEdgeBudgetRecord(edge, now), attentionBudgetOptions);
    if (budget.queued) {
      queuedEdges.push(stripUndefined({
        ...edge,
        queuedAt: iso(now),
        queuedUntil: budget.queuedUntil,
        attentionBudget: budgetSummary(budget),
      }));
      continue;
    }

    const decision = await stageDreamDecision(edge, { dataDir, now, store });
    const card = await raiseDreamBuildCard(edge, { cardStore });
    emittedEdges.push(stripUndefined({
      ...edge,
      decisionRelPath: decision.relPath,
      mutations: decision.mutations,
      cardId: card?.id,
      cardStatus: card?.status,
      emittedAt: iso(now),
      attentionBudget: budgetSummary(budget),
    }));
  }

  const nextState = nextDreamingState({
    previous: state,
    docs,
    emittedEdges,
    now,
  });
  const hitRate = await dreamingHitRate({ dataDir, cardStore, state: nextState, now, opts });
  nextState.hitRate = hitRate;
  await writeDreamingState(dataDir, nextState);
  await writeJsonFile(safeDataPath(dataDir, DREAMING_HIT_RATE_FILE), hitRate);

  const runRecord = stripUndefined({
    kind: 'DreamingRun',
    schemaVersion: DREAMING_SCHEMA_VERSION,
    runId: runBaseName,
    generatedAt: iso(now),
    atomCount: docs.length,
    attractorCount: attractors.length,
    remLinkCount: remLinks.length,
    candidateCount: candidates.length,
    emittedCount: emittedEdges.length,
    queuedCount: queuedEdges.length,
    budget: edgeBudget,
    thresholds: {
      minAttractorAtoms: positiveInteger(opts.minAttractorAtoms, DEFAULT_MIN_ATTRACTOR_ATOMS),
      attractorSimilarity: boundedNumber(
        opts.attractorSimilarityThreshold,
        DEFAULT_ATTRACTOR_SIMILARITY_THRESHOLD,
      ),
      edgeScore: boundedNumber(opts.edgeScoreThreshold, DEFAULT_EDGE_SCORE_THRESHOLD),
      remoteMaxSimilarity: boundedNumber(opts.remoteMaxSimilarity, DEFAULT_REMOTE_MAX_SIMILARITY),
      remoteMinNovelty: boundedNumber(opts.remoteMinNovelty, DEFAULT_REMOTE_MIN_NOVELTY),
      decayHalfLifeDays: positiveInteger(opts.decayHalfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS),
    },
    decay: {
      halfLifeDays: positiveInteger(opts.decayHalfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS),
      atomStates: docs.map((doc) => ({
        atomId: doc.id,
        ageDays: round3(doc.ageDays),
        decay: round3(doc.decay),
        recurringPull: round3(doc.recurringPull),
        activation: round3(doc.activation),
      })),
    },
    attractors: attractors.map(projectAttractor),
    remLinks: remLinks.map(projectRemLink),
    edges: emittedEdges.map(projectDreamEdge),
    queuedEdges: queuedEdges.map(projectDreamEdge),
    hitRate,
    frontierExcluded: true,
    provenance: {
      surface: 'mind',
      lane: 'dreaming',
    },
  });
  const relPath = await writeUniqueDataJson(dataDir, DREAMING_RUN_DIR, runBaseName, runRecord);

  return Object.freeze({
    kind: 'DreamingResult',
    schemaVersion: DREAMING_SCHEMA_VERSION,
    runId: runBaseName,
    atomCount: docs.length,
    attractorCount: attractors.length,
    remLinkCount: remLinks.length,
    candidateCount: candidates.length,
    emittedCount: emittedEdges.length,
    queuedCount: queuedEdges.length,
    edgeCards: Object.freeze(emittedEdges.map(projectDreamEdge)),
    queuedEdgeCards: Object.freeze(queuedEdges.map(projectDreamEdge)),
    hitRate,
    runPath: relPath,
    mutations: Object.freeze([
      { op: 'write', path: path.join('data', relPath), kind: 'DreamingRun' },
      { op: 'write', path: path.join('data', DREAMING_STATE_FILE), kind: 'DreamingState' },
      { op: 'write', path: path.join('data', DREAMING_HIT_RATE_FILE), kind: 'DreamingHitRate' },
      ...emittedEdges.flatMap((edge) => edge.mutations ?? []),
      ...emittedEdges
        .filter((edge) => edge.cardId)
        .map((edge) => ({
          op: 'write',
          path: path.join('data', 'build', 'cards', `${edge.cardId}.json`),
          kind: 'BuildCard',
        })),
    ]),
  });
}

function slowWaveAttractors(docs, opts = {}) {
  const minAtoms = positiveInteger(opts.minAttractorAtoms, DEFAULT_MIN_ATTRACTOR_ATOMS);
  const threshold = boundedNumber(
    opts.attractorSimilarityThreshold,
    DEFAULT_ATTRACTOR_SIMILARITY_THRESHOLD,
  );
  const graph = new Map(docs.map((doc) => [doc.id, new Set()]));

  for (let leftIndex = 0; leftIndex < docs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < docs.length; rightIndex += 1) {
      const similarity = atomSimilarity(docs[leftIndex], docs[rightIndex]);
      if (similarity < threshold) continue;
      graph.get(docs[leftIndex].id).add(docs[rightIndex].id);
      graph.get(docs[rightIndex].id).add(docs[leftIndex].id);
    }
  }

  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const seen = new Set();
  const attractors = [];
  for (const doc of docs) {
    if (seen.has(doc.id)) continue;
    const componentIds = connectedComponent(doc.id, graph, seen);
    if (componentIds.length < minAtoms) continue;
    const componentDocs = componentIds.map((id) => byId.get(id)).filter(Boolean);
    attractors.push(attractorFromDocs(componentDocs));
  }

  return attractors.sort((left, right) =>
    right.recurringPull - left.recurringPull ||
    right.convergence - left.convergence ||
    left.id.localeCompare(right.id));
}

function remRemoteLinks(attractors, opts = {}) {
  const maxSimilarity = boundedNumber(opts.remoteMaxSimilarity, DEFAULT_REMOTE_MAX_SIMILARITY);
  const minNovelty = boundedNumber(opts.remoteMinNovelty, DEFAULT_REMOTE_MIN_NOVELTY);
  const links = [];

  for (let leftIndex = 0; leftIndex < attractors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < attractors.length; rightIndex += 1) {
      const left = attractors[leftIndex];
      const right = attractors[rightIndex];
      const similarity = attractorSimilarity(left, right);
      const novelty = clampConfidence(1 - similarity);
      if (similarity > maxSimilarity || novelty < minNovelty) continue;
      const atomIds = uniqueStrings([...left.atomIds, ...right.atomIds]).sort();
      const id = dreamId('dream-link', atomIds.join('\n'));
      const recurringPull = average([left.recurringPull, right.recurringPull]);
      const convergence = Math.sqrt(left.convergence * right.convergence);
      links.push(Object.freeze({
        id,
        edgeKey: dreamId('dream-edge', `rem\n${left.id}\n${right.id}\n${atomIds.join('\n')}`),
        kind: 'rem-remote-link',
        source: 'rem',
        label: pairLabel(left.label, right.label),
        atomIds,
        conversationIds: uniqueStrings([...left.conversationIds, ...right.conversationIds]).sort(),
        evidenceIds: uniqueStrings([...left.evidenceIds, ...right.evidenceIds]).sort(),
        attractorIds: [left.id, right.id].sort(),
        convergence: clampConfidence(convergence),
        novelty,
        recurringPull: clampConfidence(recurringPull),
        edgeScore: edgeScore({ convergence, novelty, recurringPull }),
        crossSimilarity: clampConfidence(similarity),
      }));
    }
  }

  return links.sort((left, right) => right.edgeScore - left.edgeScore || left.id.localeCompare(right.id));
}

function rankedDreamEdges({
  attractors,
  remLinks,
  state,
  now,
  opts,
}) {
  const threshold = boundedNumber(opts.edgeScoreThreshold, DEFAULT_EDGE_SCORE_THRESHOLD);
  const attractorEdges = attractors.map((attractor) => {
    const novelty = noveltyForAtomIds(attractor.atomIds, state, now, opts);
    return Object.freeze({
      id: dreamId('dream-edge', `slow\n${attractor.id}\n${attractor.atomIds.join('\n')}`),
      edgeKey: dreamId('dream-edge', `slow\n${attractor.id}\n${attractor.atomIds.join('\n')}`),
      kind: 'slow-wave-attractor',
      source: 'slow-wave',
      label: attractor.label,
      atomIds: attractor.atomIds,
      conversationIds: attractor.conversationIds,
      evidenceIds: attractor.evidenceIds,
      attractorIds: [attractor.id],
      convergence: attractor.convergence,
      novelty,
      recurringPull: attractor.recurringPull,
      edgeScore: edgeScore({
        convergence: attractor.convergence,
        novelty,
        recurringPull: attractor.recurringPull,
      }),
    });
  });

  return [...remLinks, ...attractorEdges]
    .filter((edge) => edge.edgeScore >= threshold)
    .sort((left, right) =>
      right.edgeScore - left.edgeScore ||
      right.novelty - left.novelty ||
      left.edgeKey.localeCompare(right.edgeKey));
}

function buildAtomDocs(records, state, now, opts = {}) {
  const halfLifeDays = positiveInteger(opts.decayHalfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS);
  const baseDocs = records
    .map((record) => atomDoc(record, now, halfLifeDays))
    .filter(Boolean);

  return baseDocs.map((doc) => {
    const neighborCount = baseDocs
      .filter((candidate) => candidate.id !== doc.id)
      .filter((candidate) => atomSimilarity(doc, candidate) >= 0.2)
      .length;
    const sameConversationCount = doc.conversationId
      ? baseDocs.filter((candidate) => candidate.conversationId === doc.conversationId).length - 1
      : 0;
    const recurringPull = recurringPullForDoc(doc, {
      neighborCount,
      sameConversationCount,
    });
    const prior = state.atomStates?.[doc.id];
    const elapsedDays = prior?.updatedAt ? daysBetween(prior.updatedAt, now) : 0;
    const priorActivation = Number(prior?.activation) || 0;
    const priorDecayed = priorActivation * decayWeight(elapsedDays, halfLifeDays);
    const activation = clampConfidence(priorDecayed * 0.5 + recurringPull * doc.decay);
    return Object.freeze({
      ...doc,
      recurringPull,
      activation,
    });
  });
}

function atomDoc(record, now, halfLifeDays = DEFAULT_DECAY_HALF_LIFE_DAYS) {
  if (!isPlainObject(record)) return null;
  const id = optionalString(record.id);
  const statement = optionalString(record.statement);
  if (!id || !statement) return null;
  const label = boundLabel(record.label ?? statement);
  const text = [record.label, record.statement, record.type].map(optionalString).filter(Boolean).join(' ');
  const eventAt = firstString(record.eventAt, record.validFrom, record.ingestedAt) ?? iso(now);
  const ingestedAt = firstString(record.ingestedAt, record.createdAt, eventAt) ?? eventAt;
  const ageDays = Math.max(0, daysBetween(eventAt, now));
  return Object.freeze({
    id,
    label,
    type: optionalString(record.type) ?? 'idea',
    tokens: tokenize(text),
    embedding: normalizeEmbedding(
      record.embedding ??
      record.embeddingVector ??
      record.embeddings?.text ??
      record.embeddings?.statement,
    ),
    confidence: clampConfidence(record.confidence ?? 0.5),
    eventAt,
    ingestedAt,
    ageDays,
    decay: decayWeight(ageDays, halfLifeDays),
    conversationId: firstString(record.conversationId, record.source?.conversationId),
    evidenceIds: uniqueStrings([
      ...arrayValues(record.evidenceIds),
      ...arrayValues(record.sourceExposureIds),
      record.sourceExposureId,
    ]).sort(),
    editFrequency: finiteNonNegative(
      record.editFrequency ??
      record.editCount ??
      record.revisionCount ??
      record.source?.editFrequency ??
      record.source?.editCount,
    ),
  });
}

function attractorFromDocs(docs) {
  const atomIds = docs.map((doc) => doc.id).sort();
  const pairScores = pairwise(docs, atomSimilarity);
  const convergence = pairScores.length > 0 ? average(pairScores) : 1;
  const recurringPull = average(docs.map((doc) => doc.recurringPull));
  const activation = average(docs.map((doc) => doc.activation));
  return Object.freeze({
    id: dreamId('dream-attractor', atomIds.join('\n')),
    label: labelForDocs(docs),
    atomIds,
    conversationIds: uniqueStrings(docs.map((doc) => doc.conversationId)).sort(),
    evidenceIds: uniqueStrings(docs.flatMap((doc) => doc.evidenceIds)).sort(),
    docs,
    terms: topTerms(docs),
    convergence: clampConfidence(convergence),
    recurringPull: clampConfidence(recurringPull),
    activation: clampConfidence(activation),
    window: {
      start: docs.map((doc) => doc.eventAt).sort()[0],
      end: docs.map((doc) => doc.eventAt).sort().at(-1),
    },
  });
}

function connectedComponent(startId, graph, seen) {
  const stack = [startId];
  const ids = [];
  seen.add(startId);
  while (stack.length > 0) {
    const id = stack.pop();
    ids.push(id);
    for (const neighbor of graph.get(id) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      stack.push(neighbor);
    }
  }
  return ids.sort();
}

function atomSimilarity(left, right) {
  const tokenScore = jaccard(left.tokens, right.tokens);
  const embeddingScore = left.embedding.length > 0 && left.embedding.length === right.embedding.length
    ? (cosineSimilarity(left.embedding, right.embedding) + 1) / 2
    : 0;
  return clampConfidence(Math.max(tokenScore, embeddingScore));
}

function attractorSimilarity(left, right) {
  const scores = [];
  for (const leftDoc of left.docs) {
    for (const rightDoc of right.docs) {
      scores.push(atomSimilarity(leftDoc, rightDoc));
    }
  }
  return scores.length > 0 ? average(scores) : 0;
}

function edgeScore({ convergence, novelty, recurringPull }) {
  return round3(clampConfidence(convergence) * clampConfidence(novelty) * clampConfidence(recurringPull));
}

function noveltyForAtomIds(atomIds, state, now, opts = {}) {
  const repeatAfterDays = positiveInteger(opts.repeatAfterDays, DEFAULT_REPEAT_AFTER_DAYS);
  const sorted = atomIds.slice().sort();
  const latest = (state.edgeHistory ?? [])
    .filter((edge) => arraysOverlap(sorted, arrayValues(edge.atomIds)))
    .map((edge) => optionalString(edge.emittedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!latest) return 0.72;
  return clampConfidence(Math.min(1, daysBetween(latest, now) / repeatAfterDays));
}

function recurringPullForDoc(doc, { neighborCount, sameConversationCount }) {
  const evidencePull = Math.min(0.12, Math.log1p(doc.evidenceIds.length) / 12);
  const neighborPull = Math.min(0.28, neighborCount * 0.07);
  const conversationPull = Math.min(0.15, sameConversationCount * 0.05);
  const editPull = Math.min(0.15, Math.log1p(doc.editFrequency) / 10);
  const confidencePull = doc.confidence * 0.22;
  const recencyPull = doc.decay * 0.08;
  return clampConfidence(0.12 + evidencePull + neighborPull + conversationPull + editPull + confidencePull + recencyPull);
}

async function stageDreamDecision(edge, { dataDir, now, store }) {
  const signal = `signal ${formatSignalScore(edge.edgeScore)}`;
  const conversationCount = founderCountPhrase(edge.conversationIds.length, 'conversation');
  const atomCount = founderCountPhrase(edge.atomIds.length, 'idea atom');
  const output = {
    summary: `${edge.label} keep circling back — ${conversationCount}, still open. ${signal}.`,
    verdict: 'recommend',
    recommendation: {
      decision: `Build from ${edge.label}?`,
      recommended: `Review a reversible slice for ${edge.label}.`,
      reason: `${atomCount} across ${conversationCount} behind it.`,
      risk: 'low-stakes',
      reversibility: 'internal-revertible',
      undo: 'Leave it unanswered or mark it junk; no code changes.',
      evidenceIds: edge.atomIds,
      confidence: clampConfidence(edge.edgeScore),
      surface: 'mind',
      targetSurface: 'build',
      source: 'dreaming',
      recommendationKind: 'dreaming-edge-card',
      category: 'build_decide',
      target: 'build',
      action: 'review',
      object: edge.label,
      basis: 'convergence_novelty_recurring_pull',
      clusterId: edge.id,
      themeId: edge.edgeKey,
      theme: edge.label,
      atomIds: edge.atomIds,
      sourceAtomIds: edge.atomIds,
      conversationIds: edge.conversationIds,
      frontierExcluded: true,
      provenance: {
        surface: 'mind',
        lane: 'dreaming',
      },
    },
    decisionCard: {
      asked: `worth building on ${edge.label}?`,
      read: `${atomCount} across ${conversationCount}.`,
      assumed: 'the repeated pull is founder-relevant, not tool noise.',
      missing: 'your verdict before build work starts.',
      pick: `stage a reversible slice for ${edge.label}.`,
      why: `the edge crossed the dreaming threshold · ${signal}`,
      whatWouldChangeIt: 'junk verdict or stale open card.',
      next: 'choose build, hold, or dismiss.',
    },
  };
  const mutations = await commitStationOutput('decide', output, {
    dataDir,
    now: () => now,
    store,
  });
  return {
    mutations,
    relPath: mutations
      .map((mutation) => optionalString(mutation.path))
      .map(dataRelPath)
      .find(Boolean),
  };
}

async function raiseDreamBuildCard(edge, { cardStore }) {
  if (!cardStore || typeof cardStore.raiseCard !== 'function') return null;
  const signal = `signal ${formatSignalScore(edge.edgeScore)}`;
  const result = await cardStore.raiseCard({
    kind: BUILD_CARD_KIND_SHAPING,
    planId: edgePlanId(edge),
    title: edge.label,
    body: [
      `${edge.label} keep circling back — ${founderCountPhrase(edge.conversationIds.length, 'conversation')}, still open.`,
      `worth building on? · ${signal}`,
    ].join('\n'),
    options: [
      {
        id: 'build',
        label: 'build',
        consequence: 'Stage a reversible build request from this edge.',
      },
      {
        id: 'nod',
        label: 'nod',
        consequence: 'Keep the signal but do not start a build.',
      },
      {
        id: 'junk',
        label: 'junk',
        consequence: 'Dismiss this dreaming edge and count it against hit rate.',
      },
    ],
    recommendation: `worth building on? · ${signal}`,
    intent: `dreaming edge: ${edge.label}`,
    action: 'dreaming-edge',
    sourceEdgeKey: edge.edgeKey,
    dreamingEdgeKey: edge.edgeKey,
    dreamingSource: edge.source,
    atomIds: edge.atomIds,
    sourceAtomIds: edge.atomIds,
    conversationIds: edge.conversationIds,
    edgeScore: edge.edgeScore,
    convergence: edge.convergence,
    novelty: edge.novelty,
    recurringPull: edge.recurringPull,
    raisedBy: 'dreaming-v1',
  });
  return result.card;
}

async function existingDreamEdges({ dataDir, cardStore, state }) {
  const blockedEdgeKeys = new Set();

  for (const edge of state.edgeHistory ?? []) {
    const edgeKey = optionalString(edge.edgeKey);
    if (edgeKey) blockedEdgeKeys.add(edgeKey);
  }

  for (const decision of await readDecisionRecords(dataDir)) {
    if (!isLiveDreamDecision(decision)) continue;
    const edgeKey = firstString(decision.themeId, decision.clusterId, decision.metadata?.edgeKey);
    if (edgeKey) blockedEdgeKeys.add(edgeKey);
  }

  const cards = await dreamCards(cardStore);
  for (const card of cards) {
    const edgeKey = dreamCardEdgeKey(card);
    if (!edgeKey) continue;
    blockedEdgeKeys.add(edgeKey);
  }

  return { blockedEdgeKeys };
}

function recentlyEmitted(edge, state, now, opts = {}) {
  const repeatAfterDays = positiveInteger(opts.repeatAfterDays, DEFAULT_REPEAT_AFTER_DAYS);
  const emittedAt = (state.edgeHistory ?? [])
    .filter((entry) => optionalString(entry.edgeKey) === edge.edgeKey)
    .map((entry) => optionalString(entry.emittedAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  return emittedAt ? daysBetween(emittedAt, now) < repeatAfterDays : false;
}

async function dreamingHitRate({ dataDir, cardStore, state, now, opts = {} }) {
  const expireAfterDays = positiveInteger(opts.expireAfterDays, DEFAULT_EXPIRE_AFTER_DAYS);
  const knownDecisionIds = new Set(
    (state.edgeHistory ?? [])
      .flatMap((edge) => [edge.decisionRelPath, edge.decisionPath, edge.outputId])
      .map((value) => optionalString(value))
      .filter(Boolean),
  );
  const cards = await dreamCards(cardStore);
  const cardDispositions = cards
    .filter((card) => dreamCardEdgeKey(card))
    .map((card) => cardDisposition(card, now, expireAfterDays))
    .filter(Boolean);
  const evalDispositions = (await readMindEvalVerdicts(dataDir))
    .filter((entry) => entry.outputType === 'build_decide' && knownDecisionIds.has(entry.outputId))
    .map((entry) => evalDisposition(entry))
    .filter(Boolean);
  const dispositions = [...cardDispositions, ...evalDispositions];
  const acted = dispositions.filter((entry) => entry.disposition === 'acted').length;
  const dismissed = dispositions.filter((entry) => entry.disposition === 'dismissed').length;
  const expired = dispositions.filter((entry) => entry.disposition === 'expired').length;
  const neutral = dispositions.filter((entry) => entry.disposition === 'neutral').length;
  const denominator = acted + dismissed + expired;

  return {
    kind: 'DreamingHitRate',
    schemaVersion: DREAMING_SCHEMA_VERSION,
    updatedAt: iso(now),
    cardCount: cards.filter((card) => dreamCardEdgeKey(card)).length,
    dispositionCount: dispositions.length,
    acted,
    dismissed,
    expired,
    neutral,
    hitRate: denominator === 0 ? null : round3(acted / denominator),
    junkRate: denominator === 0 ? null : round3(dismissed / denominator),
  };
}

function cardDisposition(card, now, expireAfterDays) {
  const option = optionalString(card.answerOption)?.toLowerCase();
  if (option === 'build' || option === 'act-on' || option === 'act') {
    return { disposition: 'acted', source: 'build-card', id: card.id };
  }
  if (option === 'junk' || option === 'dismiss' || option === 'dismissed') {
    return { disposition: 'dismissed', source: 'build-card', id: card.id };
  }
  if (option === 'nod' || option === 'watch') {
    return { disposition: 'neutral', source: 'build-card', id: card.id };
  }
  if (isOpenOrQueuedBuildCard(card) && daysBetween(card.raisedAt ?? card.createdAt, now) >= expireAfterDays) {
    return { disposition: 'expired', source: 'build-card', id: card.id };
  }
  if (['obsoleted', 'cancelled', 'canceled'].includes(optionalString(card.status)?.toLowerCase())) {
    return { disposition: 'expired', source: 'build-card', id: card.id };
  }
  return null;
}

function evalDisposition(entry) {
  if (entry.verdict === 'act-on') return { disposition: 'acted', source: 'mind-eval', id: entry.outputId };
  if (entry.verdict === 'junk') return { disposition: 'dismissed', source: 'mind-eval', id: entry.outputId };
  if (entry.verdict === 'nod') return { disposition: 'neutral', source: 'mind-eval', id: entry.outputId };
  return null;
}

function nextDreamingState({
  previous,
  docs,
  emittedEdges,
  now,
}) {
  const atomStates = {};
  for (const doc of docs) {
    atomStates[doc.id] = {
      atomId: doc.id,
      updatedAt: iso(now),
      decay: round3(doc.decay),
      recurringPull: round3(doc.recurringPull),
      activation: round3(doc.activation),
    };
  }

  return {
    kind: 'DreamingState',
    schemaVersion: DREAMING_SCHEMA_VERSION,
    updatedAt: iso(now),
    atomStates,
    edgeHistory: [
      ...(previous.edgeHistory ?? []),
      ...emittedEdges.map((edge) => stripUndefined({
        edgeKey: edge.edgeKey,
        id: edge.id,
        label: edge.label,
        source: edge.source,
        atomIds: edge.atomIds,
        decisionRelPath: edge.decisionRelPath,
        cardId: edge.cardId,
        edgeScore: edge.edgeScore,
        emittedAt: edge.emittedAt,
      })),
    ].slice(-MAX_EDGE_HISTORY),
    hitRate: previous.hitRate ?? null,
  };
}

function projectAttractor(attractor) {
  return {
    id: attractor.id,
    label: attractor.label,
    atomIds: attractor.atomIds,
    conversationIds: attractor.conversationIds,
    terms: attractor.terms,
    convergence: round3(attractor.convergence),
    recurringPull: round3(attractor.recurringPull),
    activation: round3(attractor.activation),
    window: attractor.window,
  };
}

function projectRemLink(link) {
  return {
    id: link.id,
    edgeKey: link.edgeKey,
    label: link.label,
    atomIds: link.atomIds,
    conversationIds: link.conversationIds,
    attractorIds: link.attractorIds,
    convergence: round3(link.convergence),
    novelty: round3(link.novelty),
    recurringPull: round3(link.recurringPull),
    edgeScore: round3(link.edgeScore),
    crossSimilarity: round3(link.crossSimilarity),
  };
}

function projectDreamEdge(edge) {
  return stripUndefined({
    id: edge.id,
    edgeKey: edge.edgeKey,
    source: edge.source,
    label: edge.label,
    atomIds: edge.atomIds,
    conversationIds: edge.conversationIds,
    evidenceIds: edge.evidenceIds,
    attractorIds: edge.attractorIds,
    convergence: round3(edge.convergence),
    novelty: round3(edge.novelty),
    recurringPull: round3(edge.recurringPull),
    edgeScore: round3(edge.edgeScore),
    decisionRelPath: edge.decisionRelPath,
    cardId: edge.cardId,
    cardStatus: edge.cardStatus,
    emittedAt: edge.emittedAt,
    queuedAt: edge.queuedAt,
    queuedUntil: edge.queuedUntil,
    attentionBudget: edge.attentionBudget,
  });
}

function dreamingAttentionBudgetOptions({ dataDir, now, opts = {} }) {
  return stripUndefined({
    dataDir,
    now: () => now,
    env: opts.env,
    logger: opts.logger,
    caps: {
      ...(isPlainObject(opts.attentionBudgetCaps) ? opts.attentionBudgetCaps : {}),
      ...(opts.edgeBudget === undefined
        ? {}
        : { [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: positiveInteger(opts.edgeBudget, DEFAULT_EDGE_BUDGET) }),
    },
  });
}

function dreamEdgeBudgetRecord(edge, now) {
  return {
    category: ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
    id: edge.edgeKey,
    edgeKey: edge.edgeKey,
    title: edge.label,
    score: edge.edgeScore,
    rankScore: edge.edgeScore,
    source: 'dreaming',
    eventAt: iso(now),
    createdAt: iso(now),
  };
}

function budgetSummary(result) {
  if (!result) return undefined;
  return stripUndefined({
    status: result.status,
    category: result.category,
    cap: result.cap,
    spent: result.spent,
    queuedUntil: result.queuedUntil,
    failSoft: result.failSoft,
    path: result.path,
  });
}

async function readIdeaAtoms(dataDir) {
  const dir = safeDataPath(dataDir, IDEA_ATOM_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

function liveIdeaAtoms(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) =>
      isPlainObject(record) &&
      optionalString(record.kind) === 'IdeaAtom' &&
      !record.validTo &&
      !record.supersededById &&
      optionalString(record.id) &&
      optionalString(record.statement));
}

async function readDecisionRecords(dataDir) {
  const dir = safeDataPath(dataDir, DECISION_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

function isLiveDreamDecision(record) {
  return isPlainObject(record) &&
    optionalString(record.kind) === 'LoopRecommendation' &&
    optionalString(record.acted) === 'pending' &&
    !record.validTo &&
    !record.supersededById &&
    (
      optionalString(record.source) === 'dreaming' ||
      optionalString(record.recommendationKind) === 'dreaming-edge-card' ||
      optionalString(record.provenance?.lane) === 'dreaming'
    );
}

async function dreamCards(cardStore) {
  if (!cardStore || typeof cardStore.listCards !== 'function') return [];
  return (await cardStore.listCards()).filter((card) => Boolean(dreamCardEdgeKey(card)));
}

function dreamCardEdgeKey(card) {
  return firstString(card.sourceEdgeKey, card.dreamingEdgeKey, card.source?.edgeKey);
}

async function readMindEvalVerdicts(dataDir) {
  const dir = safeDataPath(dataDir, 'eval');
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const verdicts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^mind-\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    for (const verdict of arrayValues(parsed.verdicts)) {
      if (!isPlainObject(verdict)) continue;
      verdicts.push({
        outputType: optionalString(verdict.outputType),
        outputId: optionalString(verdict.outputId),
        verdict: optionalString(verdict.verdict),
      });
    }
  }
  return verdicts;
}

async function readDreamingState(dataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(safeDataPath(dataDir, DREAMING_STATE_FILE), 'utf8'));
    return {
      kind: 'DreamingState',
      schemaVersion: DREAMING_SCHEMA_VERSION,
      updatedAt: optionalString(parsed.updatedAt) ?? null,
      atomStates: isPlainObject(parsed.atomStates) ? parsed.atomStates : {},
      edgeHistory: Array.isArray(parsed.edgeHistory) ? parsed.edgeHistory.filter(isPlainObject) : [],
      hitRate: isPlainObject(parsed.hitRate) ? parsed.hitRate : null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return emptyDreamingState();
  }
}

function emptyDreamingState() {
  return {
    kind: 'DreamingState',
    schemaVersion: DREAMING_SCHEMA_VERSION,
    updatedAt: null,
    atomStates: {},
    edgeHistory: [],
    hitRate: null,
  };
}

async function writeDreamingState(dataDir, state) {
  await writeJsonFile(safeDataPath(dataDir, DREAMING_STATE_FILE), state);
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function labelForDocs(docs) {
  const representative = representativeLabelForDocs(docs);
  if (representative) return representative;
  const terms = topTerms(docs);
  if (terms.length > 0) return boundLabel(terms.join(' '));
  return boundLabel(docs[0]?.label ?? 'Dreaming edge');
}

function representativeLabelForDocs(docs) {
  const rankedTerms = topTerms(docs);
  if (rankedTerms.length === 0) return null;
  const termRank = new Map(rankedTerms.map((term, index) => [term, rankedTerms.length - index]));
  return docs
    .map((doc) => {
      const label = boundLabel(doc.label);
      const terms = tokenize(label);
      const score = terms.reduce((sum, term) => sum + (termRank.get(term) ?? 0), 0);
      return { label, score, words: label.split(/\s+/).filter(Boolean).length };
    })
    .filter((entry) => entry.label && entry.score > 0)
    .sort((left, right) => right.score - left.score || left.words - right.words || left.label.localeCompare(right.label))
    .at(0)?.label ?? null;
}

function pairLabel(left, right) {
  const leftLabel = boundLabel(left);
  const rightLabel = boundLabel(right);
  if (leftLabel.toLowerCase() === rightLabel.toLowerCase()) return leftLabel;
  return boundLabel(`${leftLabel} and ${rightLabel}`, 10);
}

function topTerms(docs) {
  const counts = new Map();
  for (const doc of docs) {
    for (const token of doc.tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token)
    .slice(0, MAX_TERMS);
}

function tokenize(value) {
  const tokens = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set(tokens)).sort();
}

function boundLabel(value, maxWords = 8, maxChars = 80) {
  const words = trimTrailingLabelFiller(String(value ?? '')
    .replace(/[_\W]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords));
  const label = labelWithinChars(words, maxChars);
  if (!label) return 'Dreaming edge';
  return label;
}

function labelWithinChars(words, maxChars) {
  const kept = [];
  for (const word of words) {
    const next = [...kept, word].join(' ');
    if (next.length > maxChars) break;
    kept.push(word);
  }
  return trimTrailingLabelFiller(kept).join(' ');
}

function trimTrailingLabelFiller(words) {
  const cleaned = words.slice();
  while (cleaned.length > 1 && LABEL_TRAILING_FILLER.has(cleaned.at(-1).toLowerCase())) {
    cleaned.pop();
  }
  return cleaned;
}

function founderCountPhrase(value, singular, plural = `${singular}s`) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSignalScore(value) {
  return clampConfidence(value).toFixed(2);
}

function normalizeEmbedding(value) {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
    : [];
}

function decayWeight(ageDays, halfLifeDays) {
  const halfLife = Math.max(1, Number(halfLifeDays) || DEFAULT_DECAY_HALF_LIFE_DAYS);
  return clampConfidence(Math.pow(0.5, Math.max(0, Number(ageDays) || 0) / halfLife));
}

function jaccard(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

function pairwise(values, scorer) {
  const scores = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      scores.push(scorer(values[left], values[right]));
    }
  }
  return scores;
}

function average(values) {
  const finite = values.map(Number).filter((value) => Number.isFinite(value));
  return finite.length === 0 ? 0 : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => optionalString(value))
      .filter(Boolean),
  ));
}

function arrayValues(value) {
  return Array.isArray(value) ? value : [];
}

function arraysOverlap(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function daysBetween(left, right) {
  const leftDate = dateFrom(left);
  const rightDate = dateFrom(right);
  return Math.max(0, (rightDate.getTime() - leftDate.getTime()) / (24 * 60 * 60 * 1000));
}

function round3(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

function dreamId(prefix, source) {
  return `${prefix}-${createHash('sha256').update(String(source)).digest('hex').slice(0, 16)}`;
}

function edgePlanId(edge) {
  return `dream-plan-${createHash('sha256').update(edge.edgeKey).digest('hex').slice(0, 16)}`;
}

function dataRelPath(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  if (text.startsWith(`data${path.sep}`)) return text.slice(`data${path.sep}`.length);
  if (text.startsWith('data/')) return text.slice('data/'.length);
  return text;
}
