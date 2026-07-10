import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { formatDecisionSignalLine } from './decisions.mjs';
import { createBuildCardStore } from './build-cards.mjs';
import {
  ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
  listQueuedAttentionBudgetItems,
} from './attention-budget.mjs';
import {
  CADENCE_VALUE_PROBE_ANSWERS_PATH,
  VALUE_PROBE_REVIEW_CARD_TYPE,
  attachValueProbeAnchors,
  buildValueProbeReviewCard,
  listValueAnchors,
  persistValueProbeAnswers,
} from './elicitation.mjs';
import { weeklyRetroFromDataDir } from './review-retro.mjs';
import { atomicWriteJson } from './routines.mjs';

export const REVIEW_CADENCES_DIR = 'review-cadences';
export const REVIEW_CARDS_DIR = path.join(REVIEW_CADENCES_DIR, 'cards');
export const REVIEW_CARD_KIND = 'ReviewCadenceCard';
export const REVIEW_CARD_SCHEMA_VERSION = 1;
export const REVIEW_CARD_TYPE_MORNING = 'morning-orientation';
export const REVIEW_CARD_TYPE_EVENING = 'evening-reflection';
export const REVIEW_CARD_TYPE_WEEKLY_RETRO = 'weekly-retro';
export const REVIEW_CARD_TYPE_VALUE_PROBE = VALUE_PROBE_REVIEW_CARD_TYPE;
export const REVIEW_CARD_TYPES = Object.freeze([
  REVIEW_CARD_TYPE_MORNING,
  REVIEW_CARD_TYPE_EVENING,
  REVIEW_CARD_TYPE_WEEKLY_RETRO,
  REVIEW_CARD_TYPE_VALUE_PROBE,
]);
export const REVIEW_CARD_STATUS_OPEN = 'open';
export const REVIEW_CARD_STATUS_DISMISSED = 'dismissed';
export const REVIEW_CARD_STATUSES = Object.freeze([
  REVIEW_CARD_STATUS_OPEN,
  REVIEW_CARD_STATUS_DISMISSED,
]);

export const CADENCE_REVIEW_CARDS_PATH = '/api/cadence/review-cards';
export const CADENCE_TWS_BACKFILL_PATH = '/api/cadence/tws/backfill';
export const CADENCE_TWS_NO_RESPONSE_PATH = '/api/cadence/tws/no-response';
export { CADENCE_VALUE_PROBE_ANSWERS_PATH };

export const CADENCE_TWS_DIRS = Object.freeze([
  path.join('cadence', 'tws'),
  path.join('cadence', 'acts'),
]);
export const CADENCE_TWS_OUTCOMES_DIR = path.join('cadence', 'tws');
export const TWS_OUTCOME_WELL_SPENT = 'well-spent';
export const TWS_OUTCOME_NOT_WELL_SPENT = 'not-well-spent';
export const TWS_OUTCOME_NO_RESPONSE = 'no-response';

const DECISIONS_DIR = 'decisions';
const OVERNIGHT_QUEUE_DIRS = Object.freeze([
  path.join(REVIEW_CADENCES_DIR, 'overnight-queue'),
  'overnight-queue',
]);
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const REVIEW_CARD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ANSWERED_TWS_STATUSES = new Set([
  'answered',
  TWS_OUTCOME_WELL_SPENT,
  TWS_OUTCOME_NOT_WELL_SPENT,
  TWS_OUTCOME_NO_RESPONSE,
]);

export function createReviewCadenceStore(options = {}) {
  return new ReviewCadenceStore(options);
}

export class ReviewCadenceStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = normalizeNow(options.now);
  }

  cardPath(cardId) {
    return safeDataPath(this.dataDir, reviewCardRelPath(assertReviewCardId(cardId)));
  }

  async saveCard(input = {}) {
    const card = normalizeReviewCard(input, { now: this.now() });
    await atomicWriteJson(this.cardPath(card.id), card);
    return clone(card);
  }

  async loadCard(cardId) {
    try {
      return normalizeReviewCard(JSON.parse(await fs.readFile(this.cardPath(cardId), 'utf8')), {
        now: this.now(),
      });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listCards(options = {}) {
    const normalizedCards = (await listJsonRecords(this.dataDir, REVIEW_CARDS_DIR))
      .map((entry) => normalizeReviewCard(entry.data, { now: this.now() }));
    const cards = await Promise.all(normalizedCards
      .map((card) => attachValueProbeAnchors(card, { dataDir: this.dataDir })));
    const date = options.date ? dayKey(options.date) : undefined;
    const type = options.type ? normalizeReviewCardType(options.type) : undefined;
    const status = optionalString(options.status);
    if (status && status !== 'all' && !REVIEW_CARD_STATUSES.includes(status)) {
      throw new Error(`invalid review card status: ${status}`);
    }

    return cards
      .filter((card) => !date || card.date === date)
      .filter((card) => !type || card.type === type)
      .filter((card) => !status || status === 'all' || card.status === status)
      .sort(compareReviewCards)
      .map(clone);
  }

  async generateCard(type, options = {}) {
    const cardType = normalizeReviewCardType(type);
    const now = resolveDate(options.now, this.now);
    const date = dayKey(options.date ?? now);
    const id = reviewCardId(cardType, date);
    const existing = await this.loadCard(id);
    if (existing && options.refresh !== true) {
      const card = await attachValueProbeAnchors(existing, { dataDir: this.dataDir });
      return {
        ok: true,
        created: false,
        card,
        path: path.join('data', reviewCardRelPath(existing.id)),
      };
    }

    const generated = cardType === REVIEW_CARD_TYPE_MORNING
      ? await buildMorningOrientationCard({ dataDir: this.dataDir, now, date })
      : cardType === REVIEW_CARD_TYPE_EVENING
        ? await buildEveningReflectionCard({ dataDir: this.dataDir, now, date })
        : cardType === REVIEW_CARD_TYPE_WEEKLY_RETRO
          ? await buildWeeklyRetroCard({
            dataDir: this.dataDir,
            now,
            date,
            substrateStore: options.substrateStore ?? options.store,
          })
          : await buildValueProbeCard({
            dataDir: this.dataDir,
            now,
            date,
            substrateStore: options.substrateStore ?? options.store,
          });
    const card = await this.saveCard(mergeGeneratedCard(existing, generated, now));
    return {
      ok: true,
      created: !existing,
      card,
      path: path.join('data', reviewCardRelPath(card.id)),
    };
  }

  async dismissCard(cardId, options = {}) {
    const card = await this.loadCard(cardId);
    if (!card) return null;
    if (card.status === REVIEW_CARD_STATUS_DISMISSED) return card;
    const now = resolveDate(options.now, this.now);
    return this.saveCard({
      ...card,
      status: REVIEW_CARD_STATUS_DISMISSED,
      dismissedAt: iso(now),
      updatedAt: iso(now),
    });
  }
}

export async function generateReviewCadenceCard(options = {}) {
  const store = options.store ?? createReviewCadenceStore(options);
  const type = options.type ?? options.cardType;
  return store.generateCard(type, options);
}

export async function generateMorningOrientationCard(options = {}) {
  return generateReviewCadenceCard({
    ...options,
    type: REVIEW_CARD_TYPE_MORNING,
  });
}

export async function generateEveningReflectionCard(options = {}) {
  return generateReviewCadenceCard({
    ...options,
    type: REVIEW_CARD_TYPE_EVENING,
  });
}

export async function generateWeeklyRetroCard(options = {}) {
  return generateReviewCadenceCard({
    ...options,
    type: REVIEW_CARD_TYPE_WEEKLY_RETRO,
  });
}

export async function weeklyRetroWithValueAnchorsFromDataDir(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = resolveDate(options.now);
  const [baseRetro, valueAnchors] = await Promise.all([
    weeklyRetroFromDataDir({
      ...options,
      dataDir,
      now,
      substrateStore: options.substrateStore ?? options.store,
    }),
    listValueAnchors({ dataDir }),
  ]);
  return withValueAnchorEvalHealth(baseRetro, valueAnchors, now);
}

export async function generateValueProbeCard(options = {}) {
  return generateReviewCadenceCard({
    ...options,
    type: REVIEW_CARD_TYPE_VALUE_PROBE,
  });
}

export async function recordValueProbeAnswers(options = {}) {
  const store = options.store ?? createReviewCadenceStore(options);
  const cardId = optionalString(options.cardId ?? options.id);
  if (!cardId) throw new Error('cardId is required');
  const card = options.card ?? await store.loadCard(cardId);
  if (!card) throw new Error(`review card not found: ${cardId}`);
  return persistValueProbeAnswers({
    ...options,
    dataDir: store.dataDir,
    card,
  });
}

export async function collectTwsBackfill(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = resolveDate(options.now);
  const date = dayKey(options.date ?? now);
  const records = await readCadenceTwsRecords(dataDir);
  const groups = new Map();

  for (const entry of records) {
    if (!isTwsRecord(entry.data)) continue;
    const recordDate = twsRecordDate(entry.data);
    if (recordDate !== date) continue;
    const key = twsPromptKey(entry.data, entry.relPath);
    const group = groups.get(key) ?? {
      key,
      prompt: null,
      answered: false,
    };
    if (isAnsweredTwsRecord(entry.data)) group.answered = true;
    if (isPendingTwsPrompt(entry.data)) {
      group.prompt = projectTwsPrompt(entry.data, entry.relPath, key);
    }
    groups.set(key, group);
  }

  const prompts = [...groups.values()]
    .filter((group) => group.prompt && !group.answered)
    .map((group) => group.prompt)
    .sort(compareTwsPrompts);

  return deepFreeze({
    kind: 'CadenceTwsBackfill',
    schemaVersion: 1,
    date,
    pendingCount: prompts.length,
    prompts,
    answerAction: {
      type: 'cadence.tws.backfill',
      method: 'POST',
      path: CADENCE_TWS_BACKFILL_PATH,
      body: { date, answers: [] },
    },
    finalizeNoResponseAction: {
      type: 'cadence.tws.no-response',
      method: 'POST',
      path: CADENCE_TWS_NO_RESPONSE_PATH,
      body: { date },
    },
  });
}

export async function recordTwsBackfillAnswers(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = resolveDate(options.now);
  const date = dayKey(options.date ?? now);
  const answers = normalizeTwsAnswers(options.answers);
  const pending = await collectTwsBackfill({ dataDir, date, now });
  const pendingByPrompt = new Map(pending.prompts.map((prompt) => [prompt.promptId, prompt]));
  const outcomes = [];
  let createdCount = 0;

  for (const answer of answers) {
    const prompt = pendingByPrompt.get(answer.promptId) ?? { promptId: answer.promptId };
    const write = await writeTwsOutcome({
      dataDir,
      date,
      now,
      prompt,
      outcome: answer.wellSpent ? TWS_OUTCOME_WELL_SPENT : TWS_OUTCOME_NOT_WELL_SPENT,
      wellSpent: answer.wellSpent,
    });
    outcomes.push(write.outcome);
    if (write.created) createdCount += 1;
  }

  return deepFreeze({
    ok: true,
    date,
    count: outcomes.length,
    createdCount,
    outcomes,
  });
}

export async function persistTwsNoResponseOutcomes(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const now = resolveDate(options.now);
  const date = dayKey(options.date ?? now);
  const pending = await collectTwsBackfill({ dataDir, date, now });
  const outcomes = [];
  let createdCount = 0;

  for (const prompt of pending.prompts) {
    const write = await writeTwsOutcome({
      dataDir,
      date,
      now,
      prompt,
      outcome: TWS_OUTCOME_NO_RESPONSE,
      wellSpent: null,
    });
    outcomes.push(write.outcome);
    if (write.created) createdCount += 1;
  }

  return deepFreeze({
    ok: true,
    date,
    count: outcomes.length,
    createdCount,
    outcomes,
  });
}

export function renderReviewCadenceRoutineReport(result = {}) {
  const card = result.card ?? {};
  const backfill = card.twsBackfill;
  const tws = card.retro?.evalHealth?.tws ?? {};
  const valueAnchors = card.retro?.evalHealth?.valueAnchors ?? {};
  const lines = [
    `## review cadence: ${card.type ?? 'unknown'}`,
    '',
    `card: ${card.id ?? 'unknown'}`,
    `date: ${card.date ?? 'unknown'}`,
    `status: ${card.status ?? 'unknown'}`,
  ];

  if (card.type === REVIEW_CARD_TYPE_MORNING) {
    lines.push(
      `overnight summary: ${arrayLength(card.sections?.overnightSummary)}`,
      `priorities: ${arrayLength(card.sections?.priorities)}`,
      `decisions needed: ${arrayLength(card.sections?.decisionsNeeded)}`,
    );
  }

  if (card.type === REVIEW_CARD_TYPE_EVENING) {
    lines.push(
      `wins: ${optionalString(card.sections?.wins?.prompt) ?? 'present'}`,
      `blockers: ${optionalString(card.sections?.blockers?.prompt) ?? 'present'}`,
      `tomorrow: ${optionalString(card.sections?.tomorrow?.prompt) ?? 'present'}`,
      `energy: ${optionalString(card.sections?.energy?.prompt) ?? 'present'}`,
      `tws backfill pending: ${Number(backfill?.pendingCount ?? 0)}`,
    );
  }

  if (card.type === REVIEW_CARD_TYPE_WEEKLY_RETRO) {
    lines.push(
      `goals: ${arrayLength(card.retro?.goals)}`,
      `lists: ${arrayLength(card.retro?.lists)}`,
      `tws prompts: ${Number(tws.answeredCount ?? 0)}/${Number(tws.promptCount ?? 0)} answered`,
      `decision signal: ${formatDecisionSignalLine(card.retro?.evalHealth?.decisionSignal)}`,
      `value anchors: ${Number(valueAnchors.answeredCount ?? 0)}/${Number(valueAnchors.anchorCount ?? 0)} answered`,
    );
  }

  if (card.type === REVIEW_CARD_TYPE_VALUE_PROBE) {
    lines.push(
      `probes: ${Number(card.valueProbes?.count ?? card.valueProbes?.probes?.length ?? 0)}`,
      `answered: ${Number(card.valueProbes?.answeredCount ?? 0)}`,
    );
  }

  lines.push(
    `staged: ${result.path ?? 'none'}`,
    '',
    '```json',
    JSON.stringify(card, null, 2),
    '```',
  );
  return lines.join('\n');
}

async function buildMorningOrientationCard({ dataDir, now, date }) {
  const [
    openDecisions,
    buildCards,
    overnightQueue,
  ] = await Promise.all([
    openDecisionItems(dataDir),
    openBuildCardItems(dataDir, now),
    overnightQueueItems(dataDir),
  ]);
  const window = overnightWindow(now);
  const overnightItems = [
    ...overnightQueue.filter((item) => inWindow(item.createdAt ?? item.eventAt, window)),
    ...buildCards.filter((item) => inWindow(item.raisedAt ?? item.updatedAt, window)),
  ];

  return normalizeReviewCard({
    id: reviewCardId(REVIEW_CARD_TYPE_MORNING, date),
    type: REVIEW_CARD_TYPE_MORNING,
    date,
    title: reviewCardTitle(REVIEW_CARD_TYPE_MORNING),
    status: REVIEW_CARD_STATUS_OPEN,
    window,
    sections: {
      overnightSummary: overnightItems.map(compactReviewItem),
      priorities: priorityItems({ openDecisions, buildCards, overnightQueue }),
      decisionsNeeded: [
        ...openDecisions,
        ...buildCards,
      ].map(compactReviewItem),
    },
    overnightQueue: overnightQueue.map(compactReviewItem),
    generatedAt: iso(now),
    createdAt: iso(now),
    updatedAt: iso(now),
  }, { now });
}

async function buildEveningReflectionCard({ dataDir, now, date }) {
  const [twsBackfill, overnightQueue] = await Promise.all([
    collectTwsBackfill({ dataDir, date, now }),
    overnightQueueItems(dataDir),
  ]);

  return normalizeReviewCard({
    id: reviewCardId(REVIEW_CARD_TYPE_EVENING, date),
    type: REVIEW_CARD_TYPE_EVENING,
    date,
    title: reviewCardTitle(REVIEW_CARD_TYPE_EVENING),
    status: REVIEW_CARD_STATUS_OPEN,
    sections: {
      wins: reflectionField('wins', 'wins', 'what was worth keeping?'),
      blockers: reflectionField('blockers', 'blockers', 'what blocked the day?'),
      tomorrow: reflectionField('tomorrow', 'tomorrow', 'what should tomorrow hold?'),
      overnightQueue: {
        id: 'overnightQueue',
        label: 'overnight queue',
        items: overnightQueue.map(compactReviewItem),
      },
      energy: {
        id: 'energy',
        label: 'energy',
        value: null,
        scale: { min: 1, max: 5 },
        prompt: 'where did energy land? 1/5 to 5/5',
      },
    },
    twsBackfill,
    generatedAt: iso(now),
    createdAt: iso(now),
    updatedAt: iso(now),
  }, { now });
}

async function buildWeeklyRetroCard({ dataDir, now, date, substrateStore }) {
  const retro = await weeklyRetroWithValueAnchorsFromDataDir({
    dataDir,
    now,
    substrateStore,
  });

  return normalizeReviewCard({
    id: reviewCardId(REVIEW_CARD_TYPE_WEEKLY_RETRO, date),
    type: REVIEW_CARD_TYPE_WEEKLY_RETRO,
    date,
    title: reviewCardTitle(REVIEW_CARD_TYPE_WEEKLY_RETRO),
    status: REVIEW_CARD_STATUS_OPEN,
    sections: {
      retro,
      evalHealth: retro.evalHealth,
      goals: retro.goals,
      lists: retro.lists,
    },
    retro,
    generatedAt: iso(now),
    createdAt: iso(now),
    updatedAt: iso(now),
  }, { now });
}

function withValueAnchorEvalHealth(retro, valueAnchors, now) {
  return deepFreeze({
    ...retro,
    evalHealth: {
      ...retro.evalHealth,
      valueAnchors: valueAnchorEvalPanel(valueAnchors, now),
    },
  });
}

function valueAnchorEvalPanel(valueAnchors, now) {
  const end = dayKey(now);
  const startDate = new Date(Date.parse(`${end}T00:00:00.000Z`));
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  const start = dayKey(startDate);
  const anchors = Array.isArray(valueAnchors)
    ? valueAnchors.filter((anchor) => {
      const date = dayKey(anchor.recordedAt ?? anchor.date);
      return date >= start && date <= end;
    })
    : [];
  const axes = [...new Set(anchors.map((anchor) => optionalString(anchor.axis)).filter(Boolean))].sort();
  const latestRecordedAt = anchors
    .map((anchor) => optionalString(anchor.recordedAt))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    evalLayer: 3,
    source: 'elicitation.value-anchors',
    anchorCount: anchors.length,
    answeredCount: anchors.length,
    axes,
    latestRecordedAt,
  };
}

async function buildValueProbeCard({ dataDir, now, date, substrateStore }) {
  return normalizeReviewCard(await buildValueProbeReviewCard({
    dataDir,
    now,
    date,
    substrateStore,
  }), { now });
}

function mergeGeneratedCard(existing, generated, now) {
  if (!existing) return generated;
  return normalizeReviewCard({
    ...generated,
    id: existing.id,
    status: existing.status,
    createdAt: existing.createdAt,
    dismissedAt: existing.dismissedAt,
    responses: existing.responses,
    updatedAt: iso(now),
  }, { now });
}

async function openDecisionItems(dataDir) {
  return (await listJsonRecords(dataDir, DECISIONS_DIR))
    .filter((entry) => isOpenLoopRecommendation(entry.data))
    .map((entry) => compactReviewItem({
      kind: 'decision',
      id: optionalString(entry.data.id) ?? stableId('decision', [entry.relPath]),
      sourcePath: path.join('data', entry.relPath),
      title: firstString(entry.data.decision, entry.data.summary, entry.data.recommended),
      text: firstString(entry.data.recommended, entry.data.reason),
      reason: optionalString(entry.data.reason),
      createdAt: optionalString(entry.data.createdAt),
    }))
    .sort(compareReviewItems);
}

async function openBuildCardItems(dataDir, now) {
  const store = createBuildCardStore({ dataDir, now: () => now });
  let cards = [];
  try {
    cards = await store.listOpenCards({ limit: 100 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return cards.map((card) => compactReviewItem({
    kind: 'build-card',
    id: card.id,
    title: firstString(card.title, card.body, card.kind),
    text: firstString(card.body, card.recommendation),
    status: card.status,
    severity: card.severity,
    raisedAt: card.raisedAt,
    updatedAt: card.updatedAt,
  }));
}

async function overnightQueueItems(dataDir) {
  const records = [];
  for (const dir of OVERNIGHT_QUEUE_DIRS) {
    records.push(...await listJsonRecords(dataDir, dir));
  }
  const attentionBudgetItems = listQueuedAttentionBudgetItems({ dataDir })
    .filter((item) => item.category !== ATTENTION_CATEGORY_DREAMING_EDGE_CARD)
    .map(attentionBudgetQueuedReviewItem);
  return records
    .map((entry) => compactReviewItem({
      kind: optionalString(entry.data.kind) ?? 'overnight-queue',
      id: optionalString(entry.data.id) ?? stableId('overnight', [entry.relPath]),
      sourcePath: path.join('data', entry.relPath),
      title: firstString(entry.data.title, entry.data.summary, entry.data.text),
      text: firstString(entry.data.text, entry.data.body, entry.data.summary),
      status: optionalString(entry.data.status),
      createdAt: firstString(entry.data.createdAt, entry.data.queuedAt, entry.data.eventAt),
      eventAt: optionalString(entry.data.eventAt),
    }))
    .concat(attentionBudgetItems)
    .filter((item) => item.status !== 'done' && item.status !== 'dismissed')
    .sort(compareReviewItems);
}

function attentionBudgetQueuedReviewItem(item) {
  return compactReviewItem({
    kind: 'attention-budget-queued',
    id: item.id ?? item.key,
    title: firstString(
      item.title,
      item.record?.title,
      `${item.category} queued by attention budget`,
    ),
    text: firstString(item.text, item.record?.text),
    status: item.status,
    createdAt: firstString(item.queuedAt, item.record?.createdAt),
    eventAt: item.queuedAt,
    queuedUntil: item.queuedUntil,
  });
}

function priorityItems({ openDecisions, buildCards, overnightQueue }) {
  return [
    ...openDecisions.slice(0, 3),
    ...buildCards.slice(0, 3),
    ...overnightQueue.slice(0, 3),
  ].map(compactReviewItem);
}

async function readCadenceTwsRecords(dataDir) {
  const records = [];
  for (const dir of CADENCE_TWS_DIRS) {
    records.push(...await listJsonRecords(dataDir, dir));
  }
  return records;
}

function normalizeReviewCard(input, { now } = {}) {
  if (!isPlainObject(input)) throw new Error('review card must be an object');
  const current = dateFrom(now ?? new Date());
  const type = normalizeReviewCardType(input.type ?? input.cardType);
  const date = dayKey(input.date ?? current);
  const id = assertReviewCardId(input.id ?? reviewCardId(type, date));
  const status = normalizeReviewCardStatus(input.status ?? REVIEW_CARD_STATUS_OPEN);
  const sections = isPlainObject(input.sections) ? input.sections : {};

  return deepFreeze(stripUndefined({
    id,
    kind: REVIEW_CARD_KIND,
    schemaVersion: REVIEW_CARD_SCHEMA_VERSION,
    type,
    date,
    title: reviewCardTitle(type),
    status,
    window: isPlainObject(input.window) ? input.window : undefined,
    sections,
    overnightQueue: Array.isArray(input.overnightQueue) ? input.overnightQueue : undefined,
    twsBackfill: isPlainObject(input.twsBackfill) ? input.twsBackfill : undefined,
    retro: isPlainObject(input.retro) ? input.retro : undefined,
    valueProbes: isPlainObject(input.valueProbes) ? input.valueProbes : undefined,
    responses: isPlainObject(input.responses) ? input.responses : undefined,
    generatedAt: normalizeIso(input.generatedAt ?? current, 'generatedAt'),
    createdAt: normalizeIso(input.createdAt ?? current, 'createdAt'),
    updatedAt: normalizeIso(input.updatedAt ?? input.createdAt ?? current, 'updatedAt'),
    dismissedAt: status === REVIEW_CARD_STATUS_DISMISSED
      ? normalizeIso(input.dismissedAt ?? input.updatedAt ?? current, 'dismissedAt')
      : null,
  }));
}

function normalizeReviewCardType(value) {
  const raw = optionalString(value);
  const type = raw === 'morning' ? REVIEW_CARD_TYPE_MORNING
    : raw === 'evening' ? REVIEW_CARD_TYPE_EVENING
    : raw === 'retro' || raw === 'weekly' ? REVIEW_CARD_TYPE_WEEKLY_RETRO
    : raw === 'values' || raw === 'value-probes' ? REVIEW_CARD_TYPE_VALUE_PROBE
    : raw;
  if (!REVIEW_CARD_TYPES.includes(type)) throw new Error(`invalid review card type: ${value}`);
  return type;
}

function normalizeReviewCardStatus(value) {
  const status = optionalString(value) ?? REVIEW_CARD_STATUS_OPEN;
  if (!REVIEW_CARD_STATUSES.includes(status)) throw new Error(`invalid review card status: ${value}`);
  return status;
}

function assertReviewCardId(value) {
  const id = optionalString(value);
  if (!id || !REVIEW_CARD_ID_PATTERN.test(id)) throw new Error(`invalid review card id: ${value}`);
  return id;
}

function reviewCardId(type, date) {
  return assertReviewCardId(`review-${dayKey(date)}-${normalizeReviewCardType(type)}`);
}

function reviewCardRelPath(cardId) {
  return path.join(REVIEW_CARDS_DIR, `${assertReviewCardId(cardId)}.json`);
}

function reviewCardTitle(type) {
  if (type === REVIEW_CARD_TYPE_MORNING) return 'morning orientation';
  if (type === REVIEW_CARD_TYPE_WEEKLY_RETRO) return 'weekly retro';
  if (type === REVIEW_CARD_TYPE_VALUE_PROBE) return 'value probes';
  return 'evening reflection';
}

function isOpenLoopRecommendation(record) {
  return (
    isPlainObject(record) &&
    record.kind === 'LoopRecommendation' &&
    record.station === 'decide' &&
    record.verdict === 'recommend' &&
    record.advisoryOnly === true &&
    optionalString(record.acted ?? 'pending') === 'pending'
  );
}

function isTwsRecord(record) {
  if (!isPlainObject(record)) return false;
  const kind = optionalString(record.kind)?.toLowerCase() ?? '';
  if (kind.includes('tws')) return true;
  if (Object.hasOwn(record, 'wellSpent') || Object.hasOwn(record, 'well_spent')) return true;
  if (Object.hasOwn(record, 'twsAnswer') || Object.hasOwn(record, 'twsOutcome')) return true;
  if (optionalString(record.action)?.toLowerCase() === 'well-spent') return true;
  return isPlainObject(record.tws);
}

function isPendingTwsPrompt(record) {
  if (!isTwsRecord(record)) return false;
  if (isAnsweredTwsRecord(record)) return false;
  const status = optionalString(record.status ?? record.tws?.status)?.toLowerCase();
  if (!status) return true;
  return status === 'pending' || status === 'unanswered' || status === 'open';
}

function isAnsweredTwsRecord(record) {
  const status = optionalString(record.status ?? record.outcome ?? record.twsOutcome ?? record.tws?.outcome)
    ?.toLowerCase();
  if (status && ANSWERED_TWS_STATUSES.has(status)) return true;
  if (typeof record.wellSpent === 'boolean' || typeof record.well_spent === 'boolean') return true;
  const answer = optionalString(record.answer ?? record.twsAnswer ?? record.tws?.answer)?.toLowerCase();
  return ['yes', 'no', 'true', 'false', 'well-spent', 'not-well-spent'].includes(answer);
}

function twsRecordDate(record) {
  return dayKey(
    record.date ??
    record.day ??
    record.blockDate ??
    record.tws?.date ??
    record.askedAt ??
    record.createdAt ??
    record.eventAt ??
    record.startedAt ??
    new Date(),
  );
}

function twsPromptKey(record, relPath) {
  return optionalString(
    record.promptId ??
    record.twsPromptId ??
    record.id ??
    record.tws?.promptId ??
    record.blockId ??
    record.block?.id,
  ) ?? stableId('tws-prompt', [relPath]);
}

function projectTwsPrompt(record, relPath, key) {
  const promptId = twsPromptKey(record, relPath);
  const blockId = optionalString(record.blockId ?? record.block?.id);
  return stripUndefined({
    promptId,
    id: promptId,
    blockId,
    date: twsRecordDate(record),
    title: firstString(record.blockTitle, record.title, record.block?.title, record.block?.label),
    startedAt: firstString(record.startedAt, record.block?.startedAt, record.startAt),
    endedAt: firstString(record.endedAt, record.block?.endedAt, record.endAt),
    askedAt: firstString(record.askedAt, record.createdAt, record.eventAt),
    sourcePath: path.join('data', relPath),
    key,
  });
}

function normalizeTwsAnswers(value) {
  if (!Array.isArray(value)) throw new Error('answers must be an array');
  return value.map((answer, index) => {
    if (!isPlainObject(answer)) throw new Error(`answers[${index}] must be an object`);
    const promptId = optionalString(answer.promptId ?? answer.id);
    if (!promptId) throw new Error(`answers[${index}].promptId is required`);
    return {
      promptId,
      wellSpent: normalizeWellSpent(answer.wellSpent ?? answer.well_spent ?? answer.answer),
    };
  });
}

function normalizeWellSpent(value) {
  if (typeof value === 'boolean') return value;
  const text = optionalString(value)?.toLowerCase();
  if (['yes', 'true', '1', TWS_OUTCOME_WELL_SPENT].includes(text)) return true;
  if (['no', 'false', '0', TWS_OUTCOME_NOT_WELL_SPENT].includes(text)) return false;
  throw new Error(`invalid wellSpent answer: ${value}`);
}

async function writeTwsOutcome({ dataDir, date, now, prompt, outcome, wellSpent }) {
  const id = stableId('tws-outcome', [date, prompt.promptId]);
  const relPath = path.join(CADENCE_TWS_OUTCOMES_DIR, `${id}.json`);
  const file = safeDataPath(dataDir, relPath);
  const existing = await readJsonIfExists(file);
  if (existing) {
    return { created: false, outcome: existing, path: path.join('data', relPath) };
  }

  const record = deepFreeze(stripUndefined({
    id,
    kind: 'CadenceTwsOutcome',
    schemaVersion: 1,
    date,
    promptId: prompt.promptId,
    blockId: optionalString(prompt.blockId),
    blockTitle: optionalString(prompt.title),
    outcome,
    status: outcome,
    wellSpent,
    sourcePromptPath: optionalString(prompt.sourcePath),
    recordedAt: iso(now),
    createdAt: iso(now),
  }));
  await atomicWriteJson(file, record);
  return { created: true, outcome: record, path: path.join('data', relPath) };
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

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function reflectionField(id, label, prompt) {
  return {
    id,
    label,
    items: [],
    prompt,
  };
}

function compactReviewItem(item = {}) {
  return stripUndefined({
    kind: optionalString(item.kind),
    id: optionalString(item.id),
    sourcePath: optionalString(item.sourcePath),
    title: optionalString(item.title),
    text: optionalString(item.text),
    reason: optionalString(item.reason),
    status: optionalString(item.status),
    severity: optionalString(item.severity),
    createdAt: optionalString(item.createdAt),
    raisedAt: optionalString(item.raisedAt),
    updatedAt: optionalString(item.updatedAt),
    eventAt: optionalString(item.eventAt),
    queuedUntil: optionalString(item.queuedUntil),
  });
}

function compareReviewCards(left, right) {
  return (
    right.date.localeCompare(left.date) ||
    left.type.localeCompare(right.type) ||
    left.id.localeCompare(right.id)
  );
}

function compareReviewItems(left, right) {
  return (
    nullableIso(left.createdAt ?? left.raisedAt ?? left.updatedAt ?? left.eventAt)
      .localeCompare(nullableIso(right.createdAt ?? right.raisedAt ?? right.updatedAt ?? right.eventAt)) ||
    String(left.title ?? '').localeCompare(String(right.title ?? '')) ||
    String(left.id ?? '').localeCompare(String(right.id ?? ''))
  );
}

function compareTwsPrompts(left, right) {
  return (
    nullableIso(left.endedAt ?? left.askedAt ?? left.startedAt)
      .localeCompare(nullableIso(right.endedAt ?? right.askedAt ?? right.startedAt)) ||
    String(left.blockId ?? '').localeCompare(String(right.blockId ?? '')) ||
    left.promptId.localeCompare(right.promptId)
  );
}

function nullableIso(value) {
  return optionalString(value) ?? '9999-12-31T23:59:59.999Z';
}

function overnightWindow(now) {
  const endAt = iso(now);
  const startAt = iso(new Date(now.getTime() - TWELVE_HOURS_MS));
  return { startAt, endAt };
}

function inWindow(value, window) {
  const text = optionalString(value);
  if (!text) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms >= Date.parse(window.startAt) && ms <= Date.parse(window.endAt);
}

function dayKey(value) {
  return dateFrom(value).toISOString().slice(0, 10);
}

function normalizeIso(value, label) {
  try {
    return iso(dateFrom(value));
  } catch {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function resolveDate(value, fallback = () => new Date()) {
  if (typeof value === 'function') return dateFrom(value());
  if (value !== undefined && value !== null) return dateFrom(value);
  return dateFrom(fallback());
}

function normalizeNow(value) {
  if (typeof value === 'function') return value;
  if (value === undefined) return () => new Date();
  return () => dateFrom(value);
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function stableId(prefix, parts) {
  const hash = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 20);
  return `${prefix}-${hash}`;
}

function requiredDataDir(dataDir) {
  return path.resolve(optionalString(dataDir) ?? path.join(process.cwd(), 'data'));
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
