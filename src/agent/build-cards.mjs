import { randomBytes } from 'node:crypto';
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
import {
  BUILD_DIR,
  appendHistory,
} from './build-state.mjs';
import { atomicWriteJson } from './routines.mjs';

export const BUILD_CARDS_DIR = path.join(BUILD_DIR, 'cards');
export const BUILD_CARD_KIND_PLAN_APPROVAL = 'plan-approval';
export const BUILD_CARD_KIND_SAFETY_FLOOR = 'safety-floor';
export const BUILD_CARD_KIND_DRIFT = 'drift';
export const BUILD_CARD_KIND_LINE_STOP = 'line-stop';
export const BUILD_CARD_KIND_BOUND = 'bound';
export const BUILD_CARD_KIND_INFRA = 'infra';
export const BUILD_CARD_KIND_FORK = 'fork';
export const BUILD_CARD_KIND_SHAPING = 'shaping';
export const BUILD_CARD_KINDS = Object.freeze([
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_LINE_STOP,
  BUILD_CARD_KIND_BOUND,
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_FORK,
  BUILD_CARD_KIND_SHAPING,
]);

export const BUILD_CARD_TIER_LOOPBACK = 'loopback';
export const BUILD_CARD_TIER_TAILNET = 'tailnet';
export const BUILD_CARD_TIERS = Object.freeze([
  BUILD_CARD_TIER_LOOPBACK,
  BUILD_CARD_TIER_TAILNET,
]);

export const BUILD_CARD_STATUS_QUEUED = 'queued';
export const BUILD_CARD_STATUS_RAISED = 'raised';
export const BUILD_CARD_STATUS_NOTIFIED = 'notified';
export const BUILD_CARD_STATUS_ANSWERED = 'answered';
export const BUILD_CARD_STATUS_APPLIED = 'applied';
export const BUILD_CARD_STATUS_APPLY_FAILED = 'apply-failed';
export const BUILD_CARD_STATUS_RE_RAISED = 're-raised';
export const BUILD_CARD_STATUS_OBSOLETED = 'obsoleted';
export const BUILD_CARD_STATUSES = Object.freeze([
  BUILD_CARD_STATUS_QUEUED,
  BUILD_CARD_STATUS_RAISED,
  BUILD_CARD_STATUS_NOTIFIED,
  BUILD_CARD_STATUS_ANSWERED,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_APPLY_FAILED,
  BUILD_CARD_STATUS_RE_RAISED,
  BUILD_CARD_STATUS_OBSOLETED,
]);

export const OPEN_BUILD_CARD_STATUSES = Object.freeze([
  BUILD_CARD_STATUS_RAISED,
  BUILD_CARD_STATUS_NOTIFIED,
  BUILD_CARD_STATUS_RE_RAISED,
]);
export const OPEN_OR_QUEUED_BUILD_CARD_STATUSES = Object.freeze([
  ...OPEN_BUILD_CARD_STATUSES,
  BUILD_CARD_STATUS_QUEUED,
]);
export const BUILD_CARD_DAILY_RERAISE_MS = 24 * 60 * 60 * 1000;
export const BUILD_CARD_CADENCE_NUDGE_ID_PREFIX = 'build-card:';
export const BUILD_CARD_CADENCE_ACT_PATH = '/api/cadence/nudges/disposition';
export const BUILD_CARD_ANSWER_ACTION_PATH = '/api/build/cards/answer';

const BUILD_CARD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const BUILD_CARD_OPTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

export class BuildCardError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    if (options.code) this.code = options.code;
  }
}

export class InvalidChannelError extends BuildCardError {}

export function createBuildCardStore(options = {}) {
  return new BuildCardStore(options);
}

export class BuildCardStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = options.now ?? (() => new Date());
    this.stateStore = options.stateStore ?? null;
    this.randomSuffix = options.randomSuffix ?? ((bytes = 8) => randomBytes(bytes).toString('hex'));
  }

  cardPath(cardId) {
    return cardSnapshotPath(this.dataDir, cardId);
  }

  async saveCard(card) {
    const normalized = normalizeBuildCardRecord(card, { now: this.now() });
    await atomicWriteJson(this.cardPath(normalized.id), normalized);
    return cloneRecord(normalized);
  }

  async loadCard(cardId) {
    const file = this.cardPath(cardId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return normalizeBuildCardRecord(parsed, { now: this.now() });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listCards() {
    const dir = safeDataPath(this.dataDir, BUILD_CARDS_DIR);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const cards = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      const card = await this.loadCard(id);
      if (card) cards.push(card);
    }
    return cards.sort(compareCards);
  }

  async listOpenCards(options = {}) {
    const limit = positiveInteger(options.limit, 100);
    return (await this.listCards())
      .filter((card) => isOpenOrQueuedBuildCard(card))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async raiseCard(input = {}) {
    const now = input.now ?? this.now();
    const timestamp = iso(now);
    const kind = normalizeCardKind(input.kind);
    const status = kind === BUILD_CARD_KIND_PLAN_APPROVAL && await this.#hasOpenPlanApproval()
      ? BUILD_CARD_STATUS_QUEUED
      : BUILD_CARD_STATUS_NOTIFIED;
    const card = normalizeBuildCardRecord({
      ...input,
      id: this.#newCardId(kind),
      kind,
      tier: normalizeTier(input.tier, kind),
      status,
      raisedAt: timestamp,
      queuedAt: status === BUILD_CARD_STATUS_QUEUED ? timestamp : null,
      notifiedAt: status === BUILD_CARD_STATUS_NOTIFIED ? timestamp : null,
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSeq: 1,
    }, { now });

    await this.saveCard(card);
    const event = cardEvent('build.card.raised', card, {
      fromStatus: BUILD_CARD_STATUS_RAISED,
      notified: status === BUILD_CARD_STATUS_NOTIFIED,
    });
    const history = await this.#appendCardHistory(event);
    return {
      ok: history.ok,
      card: cloneRecord(card),
      history,
      event,
      events: [event],
    };
  }

  async answerCard(input = {}) {
    const card = await this.#loadRequiredCard(input.cardId ?? input.id);

    if (hasAcceptedAnswer(card)) {
      return {
        ok: true,
        card: cloneRecord(card),
        alreadyAnswered: alreadyAnswered(card),
        changed: false,
        events: [],
      };
    }

    const channel = normalizeAnswerChannel(input);
    assertChannelAllowed(card, channel);

    if (!OPEN_BUILD_CARD_STATUSES.includes(card.status)) {
      throw new BuildCardError(`card is not answerable: ${card.id}`, { code: 'card_not_answerable' });
    }

    const optionId = assertOptionId(input.optionId, 'optionId');
    const option = card.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new BuildCardError(`invalid card option: ${optionId}`, { code: 'invalid_option' });

    const timestamp = iso(input.now ?? this.now());
    const updated = normalizeBuildCardRecord({
      ...card,
      status: BUILD_CARD_STATUS_ANSWERED,
      answeredBy: channel.by,
      answeredAt: timestamp,
      answerOption: option.id,
      answerSurface: channel.surface,
      updatedAt: timestamp,
      eventSeq: nextEventSeq(card),
    }, { now: timestamp });
    await this.saveCard(updated);

    const event = cardEvent('build.card.answered', updated, {
      optionId: option.id,
      answeredBy: updated.answeredBy,
    });
    const history = await this.#appendCardHistory(event);
    const promoted = updated.kind === BUILD_CARD_KIND_PLAN_APPROVAL
      ? await this.#promoteNextPlanApproval()
      : null;
    const events = [
      event,
      ...(promoted?.events ?? []),
    ];

    return {
      ok: history.ok && (promoted?.ok ?? true),
      card: cloneRecord(updated),
      history,
      promoted: promoted?.card ?? null,
      changed: true,
      event,
      events,
    };
  }

  async markApplied(input = {}) {
    const card = await this.#loadRequiredCard(input.cardId ?? input.id);
    if (card.status === BUILD_CARD_STATUS_APPLIED) {
      return {
        ok: true,
        card: cloneRecord(card),
        changed: false,
        events: [],
      };
    }
    if (!hasAcceptedAnswer(card)) {
      throw new BuildCardError(`card has no answer to apply: ${card.id}`, { code: 'card_not_answered' });
    }

    const timestamp = iso(input.now ?? this.now());
    const updated = normalizeBuildCardRecord({
      ...card,
      status: BUILD_CARD_STATUS_APPLIED,
      appliedAt: timestamp,
      appliedBy: optionalString(input.appliedBy ?? input.actor) ?? null,
      updatedAt: timestamp,
      eventSeq: nextEventSeq(card),
    }, { now: timestamp });
    await this.saveCard(updated);
    const event = cardEvent('build.card.applied', updated, {
      appliedBy: updated.appliedBy,
    });
    const history = await this.#appendCardHistory(event);

    return {
      ok: history.ok,
      card: cloneRecord(updated),
      history,
      changed: true,
      event,
      events: [event],
    };
  }

  async markApplyFailed(input = {}) {
    const card = await this.#loadRequiredCard(input.cardId ?? input.id);
    if (!hasAcceptedAnswer(card)) {
      throw new BuildCardError(`card has no answer to fail: ${card.id}`, { code: 'card_not_answered' });
    }

    const timestamp = iso(input.now ?? this.now());
    const failedAnswer = {
      optionId: card.answerOption,
      by: card.answeredBy,
      at: card.answeredAt,
      failedAt: timestamp,
      reason: optionalString(input.reason) ?? '',
    };
    const updated = normalizeBuildCardRecord({
      ...card,
      status: BUILD_CARD_STATUS_RE_RAISED,
      answeredBy: null,
      answeredAt: null,
      answerOption: null,
      answerSurface: null,
      applyFailedAt: timestamp,
      applyFailureReason: optionalString(input.reason) ?? '',
      reRaisedAt: timestamp,
      notifiedAt: timestamp,
      answerHistory: [
        ...answerHistory(card),
        failedAnswer,
      ],
      updatedAt: timestamp,
      eventSeq: nextEventSeq(card),
    }, { now: timestamp });
    await this.saveCard(updated);
    const event = cardEvent('build.card.apply-failed', updated, {
      reason: updated.applyFailureReason,
      failedAnswer,
    });
    const history = await this.#appendCardHistory(event);

    return {
      ok: history.ok,
      card: cloneRecord(updated),
      history,
      changed: true,
      event,
      events: [event],
    };
  }

  async obsoleteCardsFor(input = {}) {
    const planId = optionalString(input.planId);
    const laneId = optionalString(input.laneId);
    if (!planId && !laneId) {
      throw new BuildCardError('planId or laneId is required', { code: 'missing_scope' });
    }
    const supersededBy = optionalString(input.supersededBy ?? input.supersededById);
    if (!supersededBy) {
      throw new BuildCardError('supersededBy is required', { code: 'missing_supersededBy' });
    }

    const timestamp = iso(input.now ?? this.now());
    const cards = [];
    const histories = [];
    const events = [];
    for (const card of await this.listCards()) {
      if (!isOpenOrQueuedBuildCard(card)) continue;
      if (planId && card.planId !== planId) continue;
      if (laneId && card.laneId !== laneId) continue;

      const updated = normalizeBuildCardRecord({
        ...card,
        status: BUILD_CARD_STATUS_OBSOLETED,
        supersededBy,
        supersededById: supersededBy,
        obsoletedAt: timestamp,
        updatedAt: timestamp,
        eventSeq: nextEventSeq(card),
      }, { now: timestamp });
      await this.saveCard(updated);
      const event = cardEvent('build.card.obsoleted', updated, { supersededBy });
      const history = await this.#appendCardHistory(event);
      cards.push(cloneRecord(updated));
      histories.push(history);
      events.push(event);
    }

    const promoted = cards.some((card) => card.kind === BUILD_CARD_KIND_PLAN_APPROVAL)
      ? await this.#promoteNextPlanApproval()
      : null;
    if (promoted) {
      events.push(...promoted.events);
      histories.push(promoted.history);
    }

    return {
      ok: histories.every((history) => history?.ok !== false),
      cards,
      histories,
      promoted: promoted?.card ?? null,
      events,
    };
  }

  async dailyReRaise(now = this.now()) {
    const timestamp = iso(now);
    const nowMs = new Date(timestamp).getTime();
    const due = [];

    for (const card of await this.listCards()) {
      if (card.kind !== BUILD_CARD_KIND_SAFETY_FLOOR) continue;
      if (!OPEN_BUILD_CARD_STATUSES.includes(card.status)) continue;
      const notifiedAt = card.notifiedAt ?? card.raisedAt ?? card.updatedAt;
      if (nowMs - new Date(notifiedAt).getTime() < BUILD_CARD_DAILY_RERAISE_MS) continue;

      const updated = normalizeBuildCardRecord({
        ...card,
        notifiedAt: timestamp,
        dailyReRaisedAt: timestamp,
        dailyReRaiseCount: positiveInteger(card.dailyReRaiseCount, 0) + 1,
        updatedAt: timestamp,
        eventSeq: nextEventSeq(card),
      }, { now: timestamp });
      await this.saveCard(updated);
      await this.#appendCardHistory(cardEvent('build.card.re-notified', updated));
      due.push(cloneRecord(updated));
    }

    return due;
  }

  async #hasOpenPlanApproval() {
    return (await this.listCards()).some((card) =>
      card.kind === BUILD_CARD_KIND_PLAN_APPROVAL &&
      OPEN_BUILD_CARD_STATUSES.includes(card.status));
  }

  async #promoteNextPlanApproval() {
    if (await this.#hasOpenPlanApproval()) return null;
    const queued = (await this.listCards())
      .filter((card) =>
        card.kind === BUILD_CARD_KIND_PLAN_APPROVAL &&
        card.status === BUILD_CARD_STATUS_QUEUED)
      .sort((left, right) =>
        timestampMs(left.queuedAt ?? left.raisedAt) - timestampMs(right.queuedAt ?? right.raisedAt));
    const card = queued[0];
    if (!card) return null;

    const timestamp = iso(this.now());
    const updated = normalizeBuildCardRecord({
      ...card,
      status: BUILD_CARD_STATUS_NOTIFIED,
      notifiedAt: timestamp,
      updatedAt: timestamp,
      eventSeq: nextEventSeq(card),
    }, { now: timestamp });
    await this.saveCard(updated);
    const event = cardEvent('build.card.promoted', updated, {
      fromStatus: BUILD_CARD_STATUS_QUEUED,
      notified: true,
    });
    const history = await this.#appendCardHistory(event);
    return {
      ok: history.ok,
      card: cloneRecord(updated),
      history,
      event,
      events: [event],
    };
  }

  async #loadRequiredCard(cardId) {
    const id = assertCardId(cardId, 'cardId');
    const card = await this.loadCard(id);
    if (!card) throw new BuildCardError(`card not found: ${id}`, { code: 'card_not_found' });
    return card;
  }

  async #appendCardHistory(event) {
    if (this.stateStore && typeof this.stateStore.appendHistory === 'function') {
      return this.stateStore.appendHistory(event);
    }
    return appendHistory(event, { dataDir: this.dataDir, now: this.now });
  }

  #newCardId(kind) {
    for (let index = 0; index < 1000; index += 1) {
      const id = `card-${kind}-${this.randomSuffix(8)}`;
      assertCardId(id, 'card.id');
      return id;
    }
    throw new Error('could not allocate build card id');
  }
}

export function cardSnapshotPath(dataDir, cardId) {
  return safeDataPath(
    dataDir,
    path.join(BUILD_CARDS_DIR, `${assertCardId(cardId, 'cardId')}.json`),
  );
}

export function isOpenBuildCard(card) {
  return OPEN_BUILD_CARD_STATUSES.includes(optionalString(card?.status));
}

export function isOpenOrQueuedBuildCard(card) {
  return OPEN_OR_QUEUED_BUILD_CARD_STATUSES.includes(optionalString(card?.status));
}

export function buildCardCadenceNudgeId(cardId) {
  return `${BUILD_CARD_CADENCE_NUDGE_ID_PREFIX}${assertCardId(cardId, 'cardId')}`;
}

export function buildCardIdFromCadenceNudgeId(nudgeId) {
  const id = optionalString(nudgeId);
  if (!id?.startsWith(BUILD_CARD_CADENCE_NUDGE_ID_PREFIX)) return null;
  const cardId = id.slice(BUILD_CARD_CADENCE_NUDGE_ID_PREFIX.length);
  return cardId ? assertCardId(cardId, 'cardId') : null;
}

export function buildCardCadenceNudges(input = {}) {
  const date = dayKey(input.date ?? input.day ?? input.now ?? new Date());
  const blocks = normalizeCadenceBlocks(input.blocks);
  const now = normalizeDate(input.now ?? new Date());

  return (Array.isArray(input.cards) ? input.cards : [])
    .filter(isOpenBuildCard)
    .map((card) => buildCardCadenceNudge(card, { date, blocks, now }))
    .filter(Boolean);
}

export function normalizeBuildCardRecord(input, options = {}) {
  if (!isPlainObject(input)) throw new Error('build card must be an object');
  const now = iso(options.now ?? new Date());
  const extra = { ...input };
  for (const key of [
    'kind',
    'schemaVersion',
    'id',
    'planId',
    'unitId',
    'laneId',
    'tier',
    'title',
    'body',
    'options',
    'recommendation',
    'status',
    'raisedAt',
    'queuedAt',
    'notifiedAt',
    'answeredBy',
    'answeredAt',
    'answerOption',
    'answerSurface',
    'appliedAt',
    'appliedBy',
    'applyFailedAt',
    'applyFailureReason',
    'reRaisedAt',
    'obsoletedAt',
    'supersededBy',
    'supersededById',
    'answerHistory',
    'eventSeq',
    'createdAt',
    'updatedAt',
    'payload',
  ]) {
    delete extra[key];
  }

  const kind = normalizeCardKind(input.kind);
  const recommendation = optionalString(input.recommendation) ?? null;
  const bodyPayload = payloadFromBody(input.body ?? input.text);
  const payload = composePayload(input.payload, bodyPayload);
  const createdAt = normalizeIso(input.createdAt, 'card.createdAt') ?? now;
  const raisedAt = normalizeIso(input.raisedAt, 'card.raisedAt') ?? createdAt;
  const supersededBy = optionalString(input.supersededBy ?? input.supersededById) ?? null;
  return {
    ...extra,
    ...(payload ? { payload } : {}),
    kind,
    schemaVersion: 1,
    id: assertCardId(input.id, 'card.id'),
    planId: assertCardId(input.planId, 'card.planId'),
    unitId: input.unitId === undefined || input.unitId === null
      ? null
      : assertCardId(input.unitId, 'card.unitId'),
    laneId: input.laneId === undefined || input.laneId === null
      ? null
      : assertCardId(input.laneId, 'card.laneId'),
    tier: normalizeTier(input.tier, kind),
    // System-raised kinds (floor/drift/infra/plan) always get their canonical composed
    // copy. Shaping (dream/edge) cards carry bespoke founder-facing copy the raiser
    // already wrote in K's voice — keep it, so long as it is real prose, not a JSON dump.
    title: (kind === BUILD_CARD_KIND_SHAPING ? optionalString(input.title) : null)
      ?? composeBuildCardTitle(kind),
    body: (kind === BUILD_CARD_KIND_SHAPING && bodyPayload === null
      ? optionalString(input.body ?? input.text)
      : null)
      ?? composeBuildCardBody(kind, { ...input, payload, recommendation }),
    options: normalizeOptions(input.options),
    recommendation,
    status: normalizeCardStatus(input.status),
    raisedAt,
    queuedAt: normalizeIso(input.queuedAt, 'card.queuedAt'),
    notifiedAt: normalizeIso(input.notifiedAt, 'card.notifiedAt'),
    answeredBy: optionalString(input.answeredBy) ?? null,
    answeredAt: normalizeIso(input.answeredAt, 'card.answeredAt'),
    answerOption: input.answerOption === undefined || input.answerOption === null
      ? null
      : assertOptionId(input.answerOption, 'card.answerOption'),
    answerSurface: optionalString(input.answerSurface) ?? null,
    appliedAt: normalizeIso(input.appliedAt, 'card.appliedAt'),
    appliedBy: optionalString(input.appliedBy) ?? null,
    applyFailedAt: normalizeIso(input.applyFailedAt, 'card.applyFailedAt'),
    applyFailureReason: optionalString(input.applyFailureReason) ?? '',
    reRaisedAt: normalizeIso(input.reRaisedAt, 'card.reRaisedAt'),
    obsoletedAt: normalizeIso(input.obsoletedAt, 'card.obsoletedAt'),
    supersededBy,
    supersededById: supersededBy,
    answerHistory: answerHistory(input),
    eventSeq: positiveInteger(input.eventSeq, 0),
    createdAt,
    updatedAt: normalizeIso(input.updatedAt, 'card.updatedAt') ?? raisedAt,
  };
}

function normalizeOptions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('card.options must be a non-empty array');
  }
  const seen = new Set();
  return value.map((option, index) => {
    if (!isPlainObject(option)) throw new Error(`card.options[${index}] must be an object`);
    const id = assertOptionId(option.id, `card.options[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate card option id: ${id}`);
    seen.add(id);
    return {
      id,
      label: buildCardOptionLabel(id, option.label),
      consequence: buildCardOptionConsequence(id, option.consequence),
    };
  });
}

function normalizeCardKind(value) {
  const kind = optionalString(value);
  if (!kind || !BUILD_CARD_KINDS.includes(kind)) {
    throw new Error(`invalid build card kind: ${value}`);
  }
  return kind;
}

function normalizeTier(value, kind) {
  const tier = optionalString(value) ?? defaultTier(kind);
  if (!BUILD_CARD_TIERS.includes(tier)) throw new Error(`invalid build card tier: ${value}`);
  return tier;
}

function defaultTier(kind) {
  // Founder decision 2026-07-04 (recorded in build history): the founder's
  // hands are on iOS; the Mac is a headless server. The tailnet IS the trust
  // perimeter (same as every other surface incl. the substrate itself), so all
  // card kinds — including plan-approval and safety-floor — answer from any
  // tailnet device. The loopback tier remains available per-card for anything
  // deliberately pinned to the machine.
  void kind;
  return BUILD_CARD_TIER_TAILNET;
}

function normalizeCardStatus(value) {
  const status = optionalString(value) ?? BUILD_CARD_STATUS_RAISED;
  if (!BUILD_CARD_STATUSES.includes(status)) throw new Error(`invalid build card status: ${value}`);
  return status;
}

function assertCardId(value, label) {
  const id = optionalString(value);
  if (!id || !BUILD_CARD_ID_PATTERN.test(id)) throw new Error(`invalid build card id for ${label}: ${value}`);
  return id;
}

function assertOptionId(value, label) {
  const id = optionalString(value);
  if (!id || !BUILD_CARD_OPTION_ID_PATTERN.test(id)) {
    throw new Error(`invalid build card option id for ${label}: ${value}`);
  }
  return id;
}

function normalizeIso(value, label) {
  if (value === undefined || value === null) return null;
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return iso(text);
}

function normalizeAnswerChannel(input) {
  const isSameMachine = input.isSameMachine === true || input.sameMachine === true;
  const surface = optionalString(input.surface) ?? (isSameMachine ? BUILD_CARD_TIER_LOOPBACK : BUILD_CARD_TIER_TAILNET);
  return {
    isSameMachine,
    surface,
    by: isSameMachine ? BUILD_CARD_TIER_LOOPBACK : surface,
  };
}

function assertChannelAllowed(card, channel) {
  if (card.tier === BUILD_CARD_TIER_LOOPBACK && channel.isSameMachine !== true) {
    throw new InvalidChannelError('loopback channel required for build card', {
      code: 'loopback_required',
    });
  }
}

function hasAcceptedAnswer(card) {
  return Boolean(
    optionalString(card?.answeredBy) &&
    optionalString(card?.answeredAt) &&
    optionalString(card?.answerOption) &&
    [
      BUILD_CARD_STATUS_ANSWERED,
      BUILD_CARD_STATUS_APPLIED,
      BUILD_CARD_STATUS_APPLY_FAILED,
    ].includes(card.status),
  );
}

function alreadyAnswered(card) {
  return {
    by: card.answeredBy,
    at: card.answeredAt,
    optionId: card.answerOption,
  };
}

function answerHistory(card) {
  return Array.isArray(card?.answerHistory)
    ? card.answerHistory
        .filter(isPlainObject)
        .map((entry) => ({
          optionId: optionalString(entry.optionId) ?? null,
          by: optionalString(entry.by) ?? null,
          at: optionalString(entry.at) ?? null,
          failedAt: optionalString(entry.failedAt) ?? null,
          reason: optionalString(entry.reason) ?? '',
        }))
    : [];
}

function nextEventSeq(card) {
  return positiveInteger(card?.eventSeq, 0) + 1;
}

function cardEvent(kind, card, extra = {}) {
  return stripUndefined({
    kind,
    seq: card.eventSeq,
    eventSeq: card.eventSeq,
    cardId: card.id,
    id: card.id,
    planId: card.planId,
    unitId: card.unitId,
    laneId: card.laneId,
    status: card.status,
    tier: card.tier,
    card: cloneRecord(card),
    at: card.updatedAt,
    ...extra,
  });
}

function compareCards(left, right) {
  const statusDelta = statusRank(left.status) - statusRank(right.status);
  if (statusDelta !== 0) return statusDelta;
  return timestampMs(left.raisedAt ?? left.createdAt) - timestampMs(right.raisedAt ?? right.createdAt);
}

function statusRank(status) {
  switch (status) {
    case BUILD_CARD_STATUS_NOTIFIED:
    case BUILD_CARD_STATUS_RE_RAISED:
    case BUILD_CARD_STATUS_RAISED:
      return 0;
    case BUILD_CARD_STATUS_QUEUED:
      return 1;
    default:
      return 2;
  }
}

function timestampMs(value) {
  const ms = new Date(value ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildCardCadenceNudge(card, context) {
  if (!isPlainObject(card)) return null;
  const cardId = optionalString(card.id);
  if (!cardId) return null;
  const blockId = cadenceBlockIdForCard(card, context);
  if (!blockId) return null;
  const optionId = recommendedOptionId(card);
  if (!optionId) return null;

  const nudgeId = buildCardCadenceNudgeId(cardId);
  return stripUndefined({
    id: nudgeId,
    kind: 'BuildCardCadenceNudge',
    blockId,
    title: optionalString(card.title) ?? 'Build decision',
    body: optionalString(card.body ?? card.text),
    category: 'build-card',
    disposition: 'act',
    score: buildCardNudgeScore(card),
    urgency: buildCardNudgeUrgency(blockId, context),
    createdAt: normalizeIso(card.notifiedAt ?? card.raisedAt ?? card.createdAt ?? context.now, 'card.createdAt'),
    source: 'build-card',
    cardId,
    optionId,
    buildCard: {
      id: cardId,
      kind: optionalString(card.kind),
      planId: optionalString(card.planId),
      unitId: optionalString(card.unitId),
      laneId: optionalString(card.laneId),
      status: optionalString(card.status),
      tier: optionalString(card.tier),
      recommendation: optionalString(card.recommendation),
      optionId,
      options: Array.isArray(card.options) ? card.options.map(projectNudgeOption).filter(Boolean) : undefined,
    },
    act: {
      type: 'cadence.nudge.act',
      method: 'POST',
      path: BUILD_CARD_CADENCE_ACT_PATH,
      body: {
        date: context.date,
        blockId,
        nudgeId,
        disposition: 'act',
        cardId,
        optionId,
        surface: 'cadence',
      },
      routesTo: {
        type: 'build.card.answer',
        method: 'POST',
        path: BUILD_CARD_ANSWER_ACTION_PATH,
        body: {
          cardId,
          optionId,
          surface: 'cadence',
        },
      },
    },
  });
}

function cadenceBlockIdForCard(card, context) {
  const explicitBlockId = firstString(
    card.cadenceBlockId,
    card.blockId,
    card.targetBlockId,
    card.affectedBlockId,
    card.metadata?.cadenceBlockId,
    card.metadata?.blockId,
    card.metadata?.targetBlockId,
    card.cadence?.blockId,
  );
  if (explicitBlockId) {
    return context.blocks.length === 0 || context.blocks.some((block) => block.id === explicitBlockId)
      ? explicitBlockId
      : null;
  }

  const explicitDate = firstString(card.cadenceDate, card.date, card.day, card.metadata?.cadenceDate);
  if (explicitDate && dayKey(explicitDate) !== context.date) return null;

  const targetAt = firstString(
    card.cadenceAt,
    card.targetAt,
    card.dueAt,
    card.deadlineAt,
    card.scheduledAt,
    card.metadata?.cadenceAt,
    card.metadata?.targetAt,
    card.metadata?.dueAt,
  );
  if (targetAt) {
    const targetDate = normalizeDate(targetAt);
    if (dayKey(targetDate) !== context.date) return null;
    const containing = blockContainingTime(context.blocks, targetDate);
    if (containing) return containing.id;
  }

  const nowBlock = dayKey(context.now) === context.date
    ? blockContainingTime(context.blocks, context.now) ?? nextBlock(context.blocks, context.now)
    : null;
  return nowBlock?.id ?? context.blocks[0]?.id ?? null;
}

function normalizeCadenceBlocks(value) {
  return (Array.isArray(value) ? value : [])
    .map((block, index) => {
      const id = optionalString(block?.id ?? block?.blockId);
      if (!id) return null;
      return {
        id,
        index,
        startAt: normalizeOptionalDate(block?.startAt),
        endAt: normalizeOptionalDate(block?.endAt),
      };
    })
    .filter(Boolean);
}

function blockContainingTime(blocks, date) {
  const ms = date.getTime();
  return blocks.find((block) =>
    block.startAt &&
    block.endAt &&
    block.startAt.getTime() <= ms &&
    ms < block.endAt.getTime());
}

function nextBlock(blocks, date) {
  const ms = date.getTime();
  return blocks.find((block) => block.startAt && block.startAt.getTime() >= ms) ?? null;
}

function recommendedOptionId(card) {
  const recommendation = optionalString(card.recommendation);
  if (recommendation && Array.isArray(card.options) && card.options.some((option) => option?.id === recommendation)) {
    return recommendation;
  }
  return optionalString(Array.isArray(card.options) ? card.options[0]?.id : undefined);
}

function projectNudgeOption(option) {
  if (!isPlainObject(option)) return null;
  return stripUndefined({
    id: optionalString(option.id),
    label: optionalString(option.label),
    consequence: optionalString(option.consequence),
  });
}

function buildCardNudgeScore(card) {
  return 1000 + cardKindPriority(optionalString(card.kind)) + cardStatusPriority(optionalString(card.status));
}

function buildCardNudgeUrgency(blockId, context) {
  const current = blockContainingTime(context.blocks, context.now);
  if (current?.id === blockId) return 10;
  const next = nextBlock(context.blocks, context.now);
  return next?.id === blockId ? 5 : 1;
}

function cardKindPriority(kind) {
  switch (kind) {
    case BUILD_CARD_KIND_SAFETY_FLOOR:
      return 90;
    case BUILD_CARD_KIND_LINE_STOP:
      return 80;
    case BUILD_CARD_KIND_PLAN_APPROVAL:
      return 70;
    case BUILD_CARD_KIND_INFRA:
      return 60;
    case BUILD_CARD_KIND_BOUND:
      return 50;
    case BUILD_CARD_KIND_DRIFT:
      return 40;
    case BUILD_CARD_KIND_FORK:
      return 30;
    case BUILD_CARD_KIND_SHAPING:
      return 20;
    default:
      return 0;
  }
}

function cardStatusPriority(status) {
  switch (status) {
    case BUILD_CARD_STATUS_RE_RAISED:
      return 30;
    case BUILD_CARD_STATUS_NOTIFIED:
      return 20;
    case BUILD_CARD_STATUS_RAISED:
      return 10;
    default:
      return 0;
  }
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return null;
}

function normalizeDate(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (Number.isNaN(date.getTime())) throw new Error('date must be valid');
  return date;
}

function normalizeOptionalDate(value) {
  if (value === undefined || value === null) return null;
  try {
    return normalizeDate(value);
  } catch {
    return null;
  }
}

function dayKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return normalizeDate(value).toISOString().slice(0, 10);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function composeBuildCardTitle(kind) {
  switch (kind) {
    case BUILD_CARD_KIND_PLAN_APPROVAL:
      return 'plan approval';
    case BUILD_CARD_KIND_SAFETY_FLOOR:
      return 'safety floor hold';
    case BUILD_CARD_KIND_DRIFT:
      return 'scope drift hold';
    case BUILD_CARD_KIND_LINE_STOP:
      return 'line stop';
    case BUILD_CARD_KIND_BOUND:
      return 'build bound';
    case BUILD_CARD_KIND_INFRA:
      return 'infra hold';
    case BUILD_CARD_KIND_FORK:
      return 'build fork';
    case BUILD_CARD_KIND_SHAPING:
      return 'shape build request';
    default:
      return 'build decision';
  }
}

function composeBuildCardBody(kind, input = {}) {
  const state = buildCardStateFragment(kind, input);
  const act = buildCardRecommendedAct(input.recommendation, kind);
  const cost = buildCardCostFragment(kind, input);
  return `${state} — ${act}. ${cost}.`;
}

function buildCardStateFragment(kind, input) {
  const reason = humanReason(firstString(
    input.reason,
    input.payload?.reason,
    input.payload?.rawBody?.reason,
    input.payload?.rawBody?.hold?.reason,
    input.payload?.rawBody?.error,
  ));
  if (reason) return `build is held for ${reason}`;

  switch (kind) {
    case BUILD_CARD_KIND_PLAN_APPROVAL:
      return 'the plan is staged';
    case BUILD_CARD_KIND_SAFETY_FLOOR:
      return 'a safety floor blocked the lane';
    case BUILD_CARD_KIND_DRIFT:
      return 'scope moved outside the lane';
    case BUILD_CARD_KIND_LINE_STOP:
      return 'a hard gate blocked the lane';
    case BUILD_CARD_KIND_BOUND:
      return 'the build bound is hit';
    case BUILD_CARD_KIND_INFRA:
      return 'infrastructure blocked the lane';
    case BUILD_CARD_KIND_FORK:
      return 'the path forked';
    case BUILD_CARD_KIND_SHAPING:
      return 'the build request needs one answer';
    default:
      return 'build needs a decision';
  }
}

function buildCardRecommendedAct(recommendation, kind) {
  const id = optionalString(recommendation);
  if (isKnownBuildCardOptionId(id)) return buildCardOptionLabel(id);
  if (kind === BUILD_CARD_KIND_PLAN_APPROVAL) return 'approve the plan';
  if (kind === BUILD_CARD_KIND_SAFETY_FLOOR || kind === BUILD_CARD_KIND_DRIFT) return 'hold for review';
  if (kind === BUILD_CARD_KIND_SHAPING) return "use k's recommendation";
  if (id) return verbPhraseFromLabel(id);
  return 'choose the next act';
}

function buildCardCostFragment(kind, input) {
  const payload = input.payload?.rawBody ?? input.payload;
  const violationCount = Array.isArray(payload?.violations) ? payload.violations.length : null;
  if (violationCount > 0) return `${boundedCount(violationCount)} violations to clear`;
  if (payload?.protectedPath === true || kind === BUILD_CARD_KIND_SAFETY_FLOOR) return 'protected path risk';
  if (payload?.conflict === true) return 'merge conflict risk';

  switch (kind) {
    case BUILD_CARD_KIND_PLAN_APPROVAL:
      return 'reversible before build starts';
    case BUILD_CARD_KIND_DRIFT:
      return 'integration risk';
    case BUILD_CARD_KIND_LINE_STOP:
      return 'gate stays red';
    case BUILD_CARD_KIND_BOUND:
      return 'retry budget risk';
    case BUILD_CARD_KIND_INFRA:
      return 'local time cost';
    case BUILD_CARD_KIND_FORK:
      return 'merge risk';
    case BUILD_CARD_KIND_SHAPING:
      return 'drafting stays held';
    default:
      return 'review cost';
  }
}

function buildCardOptionLabel(id, fallback) {
  switch (id) {
    case 'accept-recommendation':
      return "use k's recommendation";
    case 'adopt':
      return 'adopt the lease';
    case 'answer':
      return 'answer it';
    case 'approve':
      return 'approve the plan';
    case 'build':
      return 'build it';
    case 'continue':
      return 'continue the lane';
    case 'defer':
      return 'defer it';
    case 'hold':
      return 'hold for review';
    case 'integrate':
      return 'integrate it';
    case 'junk':
      return 'junk it';
    case 'kill':
      return 'stop the work';
    case 'nod':
      return 'nod to it';
    case 'quarantine':
      return 'quarantine it';
    case 'reject':
      return 'reject the plan';
    case 'retry':
      return 'retry the lane';
    default:
      return verbPhraseFromLabel(fallback ?? id);
  }
}

function buildCardOptionConsequence(id, fallback) {
  switch (id) {
    case 'accept-recommendation':
      return "draft from k's answer.";
    case 'adopt':
      return 'take the lease without killing lanes.';
    case 'answer':
      return 'use your answer for the next draft.';
    case 'approve':
      return 'let the staged plan run.';
    case 'build':
      return 'stage a reversible build request.';
    case 'continue':
      return 'keep the lane moving.';
    case 'defer':
      return 'leave it shaped for later.';
    case 'hold':
      return 'keep it staged for review.';
    case 'integrate':
      return 'bring the lane into main.';
    case 'junk':
      return 'count it against hit rate.';
    case 'kill':
      return 'stop the affected work.';
    case 'nod':
      return 'keep the signal without starting a build.';
    case 'quarantine':
      return 'keep the failure isolated.';
    case 'reject':
      return 'cancel the staged plan.';
    case 'retry':
      return 'spend one more attempt.';
    default:
      return sentenceCaseLower(fallback) ?? '';
  }
}

function isKnownBuildCardOptionId(id) {
  return [
    'accept-recommendation',
    'adopt',
    'answer',
    'approve',
    'build',
    'continue',
    'defer',
    'hold',
    'integrate',
    'junk',
    'kill',
    'nod',
    'quarantine',
    'reject',
    'retry',
  ].includes(id);
}

function payloadFromBody(value) {
  const text = optionalString(value);
  if (!text) return null;
  const parsed = parseJsonPayload(text);
  if (parsed !== null) return { rawBody: parsed };
  if (looksLikeTemplateCopy(text)) return { sourceBody: text };
  return null;
}

function composePayload(existing, bodyPayload) {
  const base = isPlainObject(existing) ? cloneRecord(existing) : null;
  if (!base && !bodyPayload) return null;
  return stripUndefined({
    ...(base ?? {}),
    ...(bodyPayload ?? {}),
  });
}

function parseJsonPayload(value) {
  const text = optionalString(value)?.trim();
  if (!text || !/^[{\[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeTemplateCopy(value) {
  return /(?:^|\n)(Recommendation|Reasons?|Pre-check|Reasoning|Model|Scope|Track):/u.test(value);
}

function humanReason(value) {
  const text = optionalString(value);
  if (!text) return null;
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
    .toLowerCase();
}

function verbPhraseFromLabel(value) {
  const words = humanReason(value);
  if (!words) return 'choose it';
  if (/^(accept|adopt|answer|approve|build|choose|continue|defer|hold|integrate|keep|reject|retry|stop|use)\b/u.test(words)) {
    return words;
  }
  return `choose ${words}`;
}

function sentenceCaseLower(value) {
  const text = humanReason(value);
  if (!text) return null;
  return text.endsWith('.') ? text : `${text}.`;
}

function boundedCount(value) {
  const count = positiveInteger(value, 0);
  return count > 99 ? 'many' : String(count);
}

function cardDefaultTitle(kind) {
  return composeBuildCardTitle(kind);
}

function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
