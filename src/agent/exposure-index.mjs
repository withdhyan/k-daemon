import { promises as fs } from 'node:fs';
import path from 'node:path';

import { iso, safeDataPath } from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
} from '../substrate.mjs';
import {
  embed,
  embeddingCacheMetadata,
  readCachedEmbedding,
  sha256,
} from '../research/embed.mjs';

export const EXPOSURE_INDEX_DIR = 'embeddings-index';
export const EXPOSURE_INDEX_FILE = path.join(EXPOSURE_INDEX_DIR, 'exposures.json');
export const EXPOSURE_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_EXPOSURE_INDEX_BACKFILL_LIMIT = 128;
export const EMBED_STATEMENT_MAX_CHARS = 6000;
export const DEFAULT_RELEVANT_EXPOSURE_LIMIT = 14;
export const DEFAULT_RECENT_EXPOSURE_TAIL_LIMIT = 6;
export const DEFAULT_EXPOSURE_SURFACE_CAP = 8;
export const DEFAULT_SOVEREIGN_EXPOSURE_TOTAL_LIMIT = 20;

export async function backfillExposureIndex(input = {}) {
  const dataDir = path.resolve(input.dataDir ?? input.store?.dataDir ?? path.join(process.cwd(), 'data'));
  const now = dateFrom(typeof input.now === 'function' ? input.now() : input.now ?? new Date());
  const limit = normalizeNonNegativeInt(
    input.limit ?? DEFAULT_EXPOSURE_INDEX_BACKFILL_LIMIT,
    DEFAULT_EXPOSURE_INDEX_BACKFILL_LIMIT,
  );
  const store = input.store ?? createSubstrateStore({
    dataDir,
    now: () => now,
  });
  const embeddingOptions = {
    ...(input.embeddingOptions ?? {}),
    dataDir,
  };

  const liveRecords = indexableExposureRecords(await store.listRecords('Exposure'));
  const liveIds = new Set(liveRecords.map((record) => optionalString(record.id)).filter(Boolean));
  const doc = await loadExposureIndex({ dataDir });
  const entries = { ...doc.entries };
  let changed = false;

  for (const id of Object.keys(entries)) {
    if (!liveIds.has(id)) {
      delete entries[id];
      changed = true;
    }
  }

  let indexedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let capReached = false;

  for (const record of liveRecords) {
    const id = optionalString(record.id);
    const rawStatement = optionalString(record.statement);
    if (!id || !rawStatement) continue;
    // Bound the embed input: nomic's context is finite and retrieval relevance
    // doesn't need more than the head of a huge exposure. The cache key uses
    // the same truncated text so lookups stay consistent.
    const statement = rawStatement.slice(0, EMBED_STATEMENT_MAX_CHARS);

    const metadata = embeddingCacheMetadata(statement, embeddingOptions);
    const nextMetadata = exposureIndexEntry(record, metadata, dataDir, now);
    const existing = entries[id];

    if (isFreshIndexEntry(existing, nextMetadata)) {
      skippedCount += 1;
      continue;
    }

    if (indexedCount >= limit) {
      capReached = true;
      continue;
    }

    try {
      // Sovereignty invariant: embed() uses the local Ollama endpoint by
      // default; tests can inject opts.embedder, but production never calls a
      // remote/frontier embedding service here.
      const vector = await embed(statement, embeddingOptions);
      entries[id] = {
        ...nextMetadata,
        vectorHash: sha256(JSON.stringify(vector)),
      };
      indexedCount += 1;
      changed = true;
    } catch (error) {
      failedCount += 1;
      warn(input.logger, '[cs-k] exposure-index: embedding pass skipped', {
        exposureId: id,
        error: optionalString(error?.message) ?? 'embedding_failed',
      });
      // Only a transport-level failure (Ollama down/unreachable) ends the
      // pass — a per-record failure must not wall off the records behind it.
      if (isEmbedTransportError(error)) break;
    }
  }

  if (changed) {
    await writeExposureIndex({
      dataDir,
      now,
      model: firstEntryModel(entries),
      entries,
    });
  }

  return {
    ok: true,
    indexPath: exposureIndexPath(dataDir),
    indexedCount,
    skippedCount,
    failedCount,
    capReached,
    totalLive: liveRecords.length,
  };
}

export async function rankedExposureRecordsForMessage(input = {}) {
  const dataDir = path.resolve(input.dataDir ?? path.join(process.cwd(), 'data'));
  const message = optionalString(input.message ?? input.userMessage);
  if (!message) return retrievalFallback('empty_message');

  const doc = await loadExposureIndex({ dataDir });
  const entries = Object.entries(doc.entries);
  if (entries.length === 0) return retrievalFallback('empty_index');

  const embeddingOptions = {
    ...(input.embeddingOptions ?? {}),
    dataDir,
  };
  let queryVector;
  let queryModel;
  try {
    const queryMetadata = embeddingCacheMetadata(message, embeddingOptions);
    queryModel = queryMetadata.model;
    // Sovereignty invariant: query text is embedded through the same local
    // Ollama-backed helper used by backfill. No frontier lane, no remote API.
    queryVector = await embed(message, embeddingOptions);
  } catch (error) {
    warn(input.logger, '[cs-k] exposure-index: relevance embedding failed; falling back to recency', {
      error: optionalString(error?.message) ?? 'embedding_failed',
    });
    return retrievalFallback('query_embedding_failed');
  }

  const recordsById = new Map(indexableExposureRecords(input.records)
    .map((record) => [optionalString(record.id), record])
    .filter(([id]) => Boolean(id)));
  const scored = [];

  for (const [exposureId, entry] of entries) {
    const record = recordsById.get(exposureId);
    if (!record || !isPlainObject(entry)) continue;

    const rawStatement = optionalString(record.statement);
    if (!rawStatement) continue;
    // Same truncation as backfill — the index entry was built from the
    // truncated statement, so the hash must compare against the same text.
    const statement = rawStatement.slice(0, EMBED_STATEMENT_MAX_CHARS);
    if (entry.model && entry.model !== queryModel) continue;
    if (entry.textHash && entry.textHash !== sha256(statement)) continue;

    const vector = await readIndexedVector({
      dataDir,
      entry,
      model: queryModel,
      logger: input.logger,
    });
    if (!vector) continue;

    const score = cosineSimilarity(queryVector, vector);
    if (!Number.isFinite(score)) continue;
    scored.push({ record, score });
  }

  if (scored.length === 0) return retrievalFallback('no_indexed_vectors');

  scored.sort((a, b) =>
    b.score - a.score ||
    recordTime(b.record).localeCompare(recordTime(a.record)) ||
    String(a.record.id ?? '').localeCompare(String(b.record.id ?? '')));

  return {
    ok: true,
    rankedRecords: scored.map((entry) => entry.record),
    scored,
    reason: null,
  };
}

export function blendExposureRecords(input = {}) {
  const relevantLimit = normalizePositiveInt(
    input.relevantLimit ?? DEFAULT_RELEVANT_EXPOSURE_LIMIT,
    DEFAULT_RELEVANT_EXPOSURE_LIMIT,
  );
  const recentLimit = normalizePositiveInt(
    input.recentLimit ?? DEFAULT_RECENT_EXPOSURE_TAIL_LIMIT,
    DEFAULT_RECENT_EXPOSURE_TAIL_LIMIT,
  );
  const surfaceCap = normalizePositiveInt(
    input.surfaceCap ?? DEFAULT_EXPOSURE_SURFACE_CAP,
    DEFAULT_EXPOSURE_SURFACE_CAP,
  );
  const totalLimit = normalizePositiveInt(
    input.totalLimit ?? DEFAULT_SOVEREIGN_EXPOSURE_TOTAL_LIMIT,
    DEFAULT_SOVEREIGN_EXPOSURE_TOTAL_LIMIT,
  );
  const selectedIds = new Set();
  const surfaceCounts = new Map();
  const relevant = [];
  const recent = [];

  addRecords(relevant, input.relevantRecords, relevantLimit);
  addRecords(recent, input.recentRecords, recentLimit);

  return {
    records: [...relevant, ...recent],
    relevant,
    recent,
  };

  function addRecords(target, records, limit) {
    for (const record of Array.isArray(records) ? records : []) {
      if (target.length >= limit) return;
      if (relevant.length + recent.length >= totalLimit) return;
      const id = optionalString(record?.id);
      if (!id || selectedIds.has(id)) continue;
      const surface = exposureSurface(record);
      const count = surfaceCounts.get(surface) ?? 0;
      if (count >= surfaceCap) continue;
      selectedIds.add(id);
      surfaceCounts.set(surface, count + 1);
      target.push(record);
    }
  }
}

export async function loadExposureIndex(input = {}) {
  const dataDir = path.resolve(input.dataDir ?? path.join(process.cwd(), 'data'));
  try {
    const parsed = JSON.parse(await fs.readFile(exposureIndexPath(dataDir), 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
      return emptyExposureIndex();
    }
    return {
      schemaVersion: EXPOSURE_INDEX_SCHEMA_VERSION,
      kind: 'ExposureEmbeddingIndex',
      model: optionalString(parsed.model) ?? null,
      updatedAt: optionalString(parsed.updatedAt) ?? null,
      entries: Object.fromEntries(
        Object.entries(parsed.entries)
          .filter(([id, entry]) => optionalString(id) && isPlainObject(entry))
          .map(([id, entry]) => [id, normalizeIndexEntry(entry)]),
      ),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyExposureIndex();
    throw error;
  }
}

function exposureIndexEntry(record, metadata, dataDir, now) {
  return {
    cacheKey: metadata.cacheKey,
    embeddingRelPath: toDataRelPath(dataDir, metadata.cacheFile),
    textHash: metadata.textHash,
    model: metadata.model,
    surface: exposureSurface(record),
    eventAt: recordEventAt(record),
    indexedAt: iso(now),
  };
}

function isFreshIndexEntry(existing, next) {
  return isPlainObject(existing) &&
    existing.cacheKey === next.cacheKey &&
    existing.embeddingRelPath === next.embeddingRelPath &&
    existing.textHash === next.textHash &&
    existing.model === next.model &&
    existing.surface === next.surface &&
    existing.eventAt === next.eventAt;
}

async function writeExposureIndex({ dataDir, now, model, entries }) {
  const file = exposureIndexPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({
      schemaVersion: EXPOSURE_INDEX_SCHEMA_VERSION,
      kind: 'ExposureEmbeddingIndex',
      model: model ?? null,
      updatedAt: iso(now),
      entries,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function readIndexedVector({ dataDir, entry, model, logger }) {
  const relPath = optionalString(entry.embeddingRelPath);
  const cacheKey = optionalString(entry.cacheKey);
  if (!relPath && !cacheKey) return null;

  const file = safeDataPath(
    dataDir,
    relPath ?? path.join('embeddings', `${cacheKey}.json`),
  );
  try {
    return await readCachedEmbedding(file, { model });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warn(logger, '[cs-k] exposure-index: cached vector unreadable', {
        cacheKey,
        error: optionalString(error?.message) ?? 'read_failed',
      });
    }
    return null;
  }
}

function indexableExposureRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) =>
      isPlainObject(record) &&
      !record.validTo &&
      !record.supersededById &&
      optionalString(record.kind) === 'Exposure' &&
      optionalString(record.id) &&
      optionalString(record.statement));
}

function exposureIndexPath(dataDir) {
  return safeDataPath(dataDir, EXPOSURE_INDEX_FILE);
}

function emptyExposureIndex() {
  return {
    schemaVersion: EXPOSURE_INDEX_SCHEMA_VERSION,
    kind: 'ExposureEmbeddingIndex',
    model: null,
    updatedAt: null,
    entries: {},
  };
}

function normalizeIndexEntry(entry) {
  return {
    cacheKey: optionalString(entry.cacheKey) ?? null,
    embeddingRelPath: optionalString(entry.embeddingRelPath ?? entry.vectorRelPath) ?? null,
    textHash: optionalString(entry.textHash) ?? null,
    vectorHash: optionalString(entry.vectorHash) ?? null,
    model: optionalString(entry.model) ?? null,
    surface: optionalString(entry.surface) ?? null,
    eventAt: optionalString(entry.eventAt) ?? null,
    indexedAt: optionalString(entry.indexedAt) ?? null,
  };
}

function retrievalFallback(reason) {
  return {
    ok: false,
    reason,
    rankedRecords: [],
    scored: [],
  };
}

function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return Number.NaN;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return Number.NaN;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function recordTime(record) {
  return optionalString(record?.eventAt) ??
    optionalString(record?.createdAt) ??
    optionalString(record?.validFrom) ??
    optionalString(record?.ingestedAt) ??
    '';
}

function recordEventAt(record) {
  return optionalString(record?.eventAt) ??
    optionalString(record?.validFrom) ??
    optionalString(record?.createdAt) ??
    optionalString(record?.ingestedAt) ??
    null;
}

function exposureSurface(record) {
  return optionalString(record?.provenance?.surface) ?? 'unknown';
}

function firstEntryModel(entries) {
  for (const entry of Object.values(entries)) {
    const model = optionalString(entry?.model);
    if (model) return model;
  }
  return null;
}

function toDataRelPath(dataDir, file) {
  return path.relative(path.resolve(dataDir), path.resolve(file)).split(path.sep).join('/');
}

function normalizePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function warn(logger, message, meta) {
  const target = logger && typeof logger.warn === 'function' ? logger : console;
  if (typeof target.warn === 'function') {
    target.warn(message, meta);
  }
}

// Transport-level embed failures (service down/unreachable) — the only errors
// that justify ending a backfill pass early.
function isEmbedTransportError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timed out');
}
