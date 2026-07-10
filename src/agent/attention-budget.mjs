import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ATTENTION_BUDGET_DIR = 'attention-budget';
export const ATTENTION_CATEGORY_CADENCE_NUDGE = 'cadence-nudge';
export const ATTENTION_CATEGORY_BODY_CUE = 'body-cue';
export const ATTENTION_CATEGORY_DREAMING_EDGE_CARD = 'dreaming-edge-card';

export const ATTENTION_BUDGET_DEFAULT_CAPS = Object.freeze({
  [ATTENTION_CATEGORY_CADENCE_NUDGE]: 3,
  [ATTENTION_CATEGORY_BODY_CUE]: 2,
  [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: 2,
});

export const ATTENTION_BUDGET_ENV = Object.freeze({
  [ATTENTION_CATEGORY_CADENCE_NUDGE]: 'K_ATTENTION_BUDGET_CADENCE_NUDGES_PER_DAY',
  [ATTENTION_CATEGORY_BODY_CUE]: 'K_ATTENTION_BUDGET_BODY_CUES_PER_DAY',
  [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: 'K_ATTENTION_BUDGET_DREAMING_EDGE_CARDS_PER_NIGHT',
});

export function categoryCap(category, options = {}) {
  const normalized = normalizeCategory(category);
  const explicit = capFromObject(options.caps, normalized);
  if (explicit !== undefined) return explicit;
  const env = options.env ?? process.env;
  const envCap = parseCap(env?.[ATTENTION_BUDGET_ENV[normalized]]);
  if (envCap !== undefined) return envCap;
  return ATTENTION_BUDGET_DEFAULT_CAPS[normalized];
}

export function spentToday(category, options = {}) {
  const normalized = normalizeCategory(category);
  const date = dayKey(options.date ?? resolveNow(options.now));
  const logger = options.logger ?? console;

  try {
    const doc = readBudgetDoc(resolveDataDir(options.dataDir), date);
    return nonNegativeInteger(doc.spent?.[normalized]);
  } catch (error) {
    logBudgetStoreError(logger, 'spentToday', error);
    return 0;
  }
}

export function admit(record, options = {}) {
  const now = resolveNow(options.now);
  const category = normalizeCategory(record?.category);
  const date = dayKey(record?.date ?? now);
  const dataDir = resolveDataDir(options.dataDir);
  const logger = options.logger ?? console;
  const cap = categoryCap(category, options);
  const key = budgetKey(record, category);
  const admittedAt = iso(now);

  try {
    const doc = readBudgetDoc(dataDir, date);
    const existingAdmitted = (doc.admitted ?? []).find((entry) => entry.key === key);
    if (existingAdmitted) {
      return deepFreeze(stripUndefined({
        status: 'admitted',
        admitted: true,
        queued: false,
        category,
        key,
        date,
        cap,
        spent: nonNegativeInteger(doc.spent?.[category]),
        path: budgetRelPath(date),
        idempotent: true,
      }));
    }

    const existingQueued = (doc.queued ?? []).find((entry) => entry.key === key && entry.status === 'queued');
    if (existingQueued) {
      return deepFreeze(stripUndefined({
        status: 'queued',
        admitted: false,
        queued: true,
        category,
        key,
        date,
        cap,
        spent: nonNegativeInteger(doc.spent?.[category]),
        queuedUntil: existingQueued.queuedUntil,
        item: clone(existingQueued),
        path: budgetRelPath(date),
        idempotent: true,
      }));
    }

    const spent = nonNegativeInteger(doc.spent?.[category]);
    if (spent < cap) {
      const entry = admittedEntry(record, { category, key, admittedAt });
      const next = normalizeBudgetDoc({
        ...doc,
        spent: {
          ...doc.spent,
          [category]: spent + 1,
        },
        admitted: [...(doc.admitted ?? []), entry].sort(compareBudgetEntries),
      }, date);
      writeBudgetDoc(dataDir, next);
      return deepFreeze(stripUndefined({
        status: 'admitted',
        admitted: true,
        queued: false,
        category,
        key,
        date,
        cap,
        spent: spent + 1,
        item: entry,
        path: budgetRelPath(date),
      }));
    }

    const queued = queuedEntry(record, {
      category,
      key,
      queuedAt: admittedAt,
      queuedUntil: optionalIso(record?.queuedUntil) ?? defaultQueuedUntil(category, now),
    });
    const next = normalizeBudgetDoc({
      ...doc,
      queued: [...(doc.queued ?? []), queued].sort(compareQueuedEntries),
    }, date);
    writeBudgetDoc(dataDir, next);
    return deepFreeze(stripUndefined({
      status: 'queued',
      admitted: false,
      queued: true,
      category,
      key,
      date,
      cap,
      spent,
      queuedUntil: queued.queuedUntil,
      item: queued,
      path: budgetRelPath(date),
    }));
  } catch (error) {
    logBudgetStoreError(logger, 'admit', error);
    return deepFreeze(stripUndefined({
      status: 'admitted',
      admitted: true,
      queued: false,
      category,
      key,
      date,
      cap,
      spent: 0,
      failSoft: true,
      error: optionalString(error?.message),
    }));
  }
}

export function listQueuedAttentionBudgetItems(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const logger = options.logger ?? console;
  const dir = safeDataPath(dataDir, ATTENTION_BUDGET_DIR);
  const items = [];

  try {
    if (!existsSync(dir)) return [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const date = entry.name.slice(0, -5);
      const doc = readBudgetDoc(dataDir, date);
      for (const item of doc.queued ?? []) {
        if (item.status === 'queued') items.push(clone(item));
      }
    }
  } catch (error) {
    logBudgetStoreError(logger, 'listQueuedAttentionBudgetItems', error);
    return [];
  }

  return items.sort(compareQueuedEntries);
}

export function attentionBudgetConfig(env = process.env) {
  return Object.freeze(Object.fromEntries(
    Object.keys(ATTENTION_BUDGET_DEFAULT_CAPS).map((category) => [
      category,
      categoryCap(category, { env }),
    ]),
  ));
}

function readBudgetDoc(dataDir, date) {
  const file = budgetFile(dataDir, date);
  if (!existsSync(file)) return normalizeBudgetDoc({}, date);
  return normalizeBudgetDoc(JSON.parse(readFileSync(file, 'utf8')), date);
}

function writeBudgetDoc(dataDir, doc) {
  const normalized = normalizeBudgetDoc({
    ...doc,
    updatedAt: iso(new Date()),
  }, doc.date);
  atomicWriteJsonSync(budgetFile(dataDir, normalized.date), normalized);
}

function normalizeBudgetDoc(input, dateInput) {
  const date = dayKey(dateInput ?? input?.date ?? new Date());
  const spent = {};
  for (const category of Object.keys(ATTENTION_BUDGET_DEFAULT_CAPS)) {
    const value = nonNegativeInteger(input?.spent?.[category]);
    if (value > 0) spent[category] = value;
  }
  return deepFreeze(stripUndefined({
    kind: 'AttentionBudgetDay',
    schemaVersion: SCHEMA_VERSION,
    date,
    spent,
    admitted: Array.isArray(input?.admitted)
      ? input.admitted.map((entry) => normalizeAdmittedEntry(entry)).filter(Boolean).sort(compareBudgetEntries)
      : [],
    queued: Array.isArray(input?.queued)
      ? input.queued.map((entry) => normalizeQueuedEntry(entry)).filter(Boolean).sort(compareQueuedEntries)
      : [],
    updatedAt: optionalIso(input?.updatedAt) ?? iso(new Date()),
  }));
}

function admittedEntry(record, { category, key, admittedAt }) {
  return stripUndefined({
    kind: 'AttentionBudgetAdmittedItem',
    schemaVersion: SCHEMA_VERSION,
    category,
    key,
    id: recordId(record),
    title: optionalString(record?.title ?? record?.summary ?? record?.label),
    source: optionalString(record?.source),
    rank: rankValue(record),
    admittedAt,
  });
}

function queuedEntry(record, { category, key, queuedAt, queuedUntil }) {
  return stripUndefined({
    kind: 'AttentionBudgetQueuedItem',
    schemaVersion: SCHEMA_VERSION,
    status: 'queued',
    category,
    key,
    id: recordId(record),
    title: optionalString(record?.title ?? record?.summary ?? record?.label),
    text: optionalString(record?.text ?? record?.body),
    source: optionalString(record?.source),
    rank: rankValue(record),
    queuedAt,
    queuedUntil,
    record: queueRecord(record),
  });
}

function normalizeAdmittedEntry(value) {
  if (!isPlainObject(value)) return null;
  const category = maybeNormalizeCategory(value.category);
  const key = optionalString(value.key);
  if (!category || !key) return null;
  return stripUndefined({
    kind: 'AttentionBudgetAdmittedItem',
    schemaVersion: SCHEMA_VERSION,
    category,
    key,
    id: optionalString(value.id),
    title: optionalString(value.title),
    source: optionalString(value.source),
    rank: finiteNumber(value.rank),
    admittedAt: optionalIso(value.admittedAt),
  });
}

function normalizeQueuedEntry(value) {
  if (!isPlainObject(value)) return null;
  const category = maybeNormalizeCategory(value.category);
  const key = optionalString(value.key);
  const queuedUntil = optionalIso(value.queuedUntil);
  if (!category || !key || !queuedUntil) return null;
  return stripUndefined({
    kind: 'AttentionBudgetQueuedItem',
    schemaVersion: SCHEMA_VERSION,
    status: optionalString(value.status) ?? 'queued',
    category,
    key,
    id: optionalString(value.id),
    title: optionalString(value.title),
    text: optionalString(value.text),
    source: optionalString(value.source),
    rank: finiteNumber(value.rank),
    queuedAt: optionalIso(value.queuedAt),
    queuedUntil,
    record: isPlainObject(value.record) ? clone(value.record) : undefined,
  });
}

function queueRecord(record) {
  if (!isPlainObject(record)) return undefined;
  const safe = stripUndefined({
    id: recordId(record),
    category: maybeNormalizeCategory(record.category),
    title: optionalString(record.title ?? record.summary ?? record.label),
    text: optionalString(record.text ?? record.body),
    source: optionalString(record.source),
    blockId: optionalString(record.blockId),
    cardId: optionalString(record.cardId ?? record.buildCardId),
    edgeKey: optionalString(record.edgeKey ?? record.dreamingEdgeKey),
    cueKind: optionalString(record.cueKind ?? record.kind),
    score: finiteNumber(record.score ?? record.rankScore ?? record.edgeScore),
    rank: rankValue(record),
    createdAt: optionalIso(record.createdAt ?? record.eventAt),
  });
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function compareBudgetEntries(left, right) {
  return (
    left.category.localeCompare(right.category) ||
    nullableIso(left.admittedAt).localeCompare(nullableIso(right.admittedAt)) ||
    left.key.localeCompare(right.key)
  );
}

function compareQueuedEntries(left, right) {
  return (
    left.category.localeCompare(right.category) ||
    nullableIso(left.queuedUntil).localeCompare(nullableIso(right.queuedUntil)) ||
    (finiteNumber(right.rank) ?? 0) - (finiteNumber(left.rank) ?? 0) ||
    nullableIso(left.queuedAt).localeCompare(nullableIso(right.queuedAt)) ||
    left.key.localeCompare(right.key)
  );
}

function budgetKey(record, category) {
  const explicit = optionalString(
    record?.key ??
    record?.attentionBudgetKey ??
    record?.id ??
    record?.nudgeId ??
    record?.cueId ??
    record?.packetId ??
    record?.edgeKey ??
    record?.dreamingEdgeKey ??
    record?.cardId,
  );
  const raw = explicit ?? stableJson(record ?? {});
  return `${category}:${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function recordId(record) {
  return optionalString(
    record?.id ??
    record?.nudgeId ??
    record?.cueId ??
    record?.packetId ??
    record?.edgeKey ??
    record?.dreamingEdgeKey ??
    record?.cardId,
  );
}

function rankValue(record) {
  const weighted = Number(record?.rankScore ?? record?.score ?? record?.priority ?? record?.edgeScore);
  if (Number.isFinite(weighted)) return weighted;
  const relevance = Number(record?.relevance);
  const confidence = Number(record?.confidence);
  if (Number.isFinite(relevance) && Number.isFinite(confidence)) return relevance * confidence;
  const rank = Number(record?.rank);
  return Number.isFinite(rank) ? rank : 0;
}

function defaultQueuedUntil(category, now) {
  const date = dateFrom(now);
  const next = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    category === ATTENTION_CATEGORY_DREAMING_EDGE_CARD ? 3 : 6,
    0,
    0,
    0,
  ));
  return iso(next);
}

function capFromObject(value, category) {
  if (!isPlainObject(value)) return undefined;
  return parseCap(value[category] ?? value[category.replaceAll('-', '_')]);
}

function parseCap(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeCategory(value) {
  const category = maybeNormalizeCategory(value);
  if (!category) throw new Error(`invalid attention budget category: ${value}`);
  return category;
}

function maybeNormalizeCategory(value) {
  const raw = optionalString(value)?.toLowerCase().replace(/_/g, '-');
  if (!raw) return undefined;
  if (['cadence', 'cadence-nudges', 'cadence-nudge'].includes(raw)) {
    return ATTENTION_CATEGORY_CADENCE_NUDGE;
  }
  if (['body', 'body-cues', 'body-cue', 'body-live-cue'].includes(raw)) {
    return ATTENTION_CATEGORY_BODY_CUE;
  }
  if (['dreaming', 'dreaming-edge-cards', 'dreaming-edge-card', 'edge-card'].includes(raw)) {
    return ATTENTION_CATEGORY_DREAMING_EDGE_CARD;
  }
  return Object.hasOwn(ATTENTION_BUDGET_DEFAULT_CAPS, raw) ? raw : undefined;
}

function budgetFile(dataDir, date) {
  return safeDataPath(dataDir, budgetRelPath(dayKey(date)));
}

function budgetRelPath(date) {
  return path.join(ATTENTION_BUDGET_DIR, `${dayKey(date)}.json`);
}

function resolveDataDir(dataDir) {
  return path.resolve(dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
}

function resolveNow(now) {
  return dateFrom(typeof now === 'function' ? now() : now ?? new Date());
}

function dayKey(value) {
  return dateFrom(value).toISOString().slice(0, 10);
}

function optionalIso(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return iso(value);
}

function iso(value) {
  return dateFrom(value).toISOString();
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function nullableIso(value) {
  return optionalString(value) ?? '9999-12-31T23:59:59.999Z';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonNegativeInteger(value) {
  const number = Math.floor(Number(value ?? 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function safeDataPath(dataDir, relPath) {
  const root = path.resolve(dataDir);
  const rel = String(relPath ?? '');
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }
  return resolved;
}

function atomicWriteJsonSync(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

function logBudgetStoreError(logger, action, error) {
  const failSoft = action === 'admit' ? '; admitting fail-soft' : '';
  logger?.warn?.(`[cs-k] attention budget ${action} failed${failSoft}: ${error.message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
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
