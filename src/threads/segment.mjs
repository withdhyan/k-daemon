import { embed } from '../research/embed.mjs';
import { cosineSimilarity } from '../research/vrsd.mjs';
import {
  optionalString,
  requiredString,
} from '../substrate.mjs';

export const cosineSim = cosineSimilarity;

const DEFAULT_SIMILARITY_THRESHOLD = 0.76;
const DEFAULT_MAX_TEMPORAL_GAP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_PREFIX = 'thread';

const THEME_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'another',
  'because',
  'before',
  'being',
  'between',
  'could',
  'default',
  'every',
  'from',
  'have',
  'into',
  'keep',
  'make',
  'more',
  'must',
  'need',
  'only',
  'over',
  'prefer',
  'should',
  'that',
  'their',
  'them',
  'then',
  'there',
  'this',
  'through',
  'unless',
  'with',
  'without',
  'would',
]);

export async function segment(exposures, opts = {}) {
  if (!Array.isArray(exposures)) {
    throw new Error('exposures must be an array');
  }
  if (exposures.length === 0) return [];

  const items = await embeddedExposureItems(exposures, opts);
  if (items.length === 0) return [];

  const threshold = finiteNumber(
    opts.similarityThreshold ?? opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    'similarityThreshold',
  );
  const maxTemporalGapMs = nonNegativeNumber(
    opts.maxTemporalGapMs ?? opts.temporalGapMs ?? DEFAULT_MAX_TEMPORAL_GAP_MS,
    'maxTemporalGapMs',
  );
  const prefix = optionalString(opts.threadIdPrefix) ?? DEFAULT_THREAD_PREFIX;
  const threads = [];
  let partition = 0;
  let previous = null;

  for (const item of items) {
    if (previous && hardBoundary(previous, item, maxTemporalGapMs)) {
      partition += 1;
    }

    const best = bestThread(item, threads, { partition, threshold });
    if (best) {
      addToThread(best, item);
    } else {
      threads.push(createThread(item, {
        id: `${prefix}_${String(threads.length + 1).padStart(3, '0')}`,
        partition,
      }));
    }

    previous = item;
  }

  return threads.map(({ centroid, items: threadItems, partition: _partition, ...thread }) => ({
    ...thread,
    theme: themeFor(threadItems),
  }));
}

async function embeddedExposureItems(exposures, opts) {
  const embeddingOpts = embeddingOptions(opts);
  const items = await Promise.all(exposures.map(async (exposure, index) => {
    const normalized = normalizeExposure(exposure, index);
    const embedding = Array.isArray(exposure.embedding)
      ? exposure.embedding
      : await embed(normalized.statement, embeddingOpts);

    if (!Array.isArray(embedding) || embedding.length === 0) {
      return null;
    }

    return {
      ...normalized,
      embedding,
      exposure,
    };
  }));

  return items
    .filter(Boolean)
    .sort(compareItems);
}

function normalizeExposure(exposure, index) {
  if (!exposure || typeof exposure !== 'object' || Array.isArray(exposure)) {
    throw new Error(`exposures[${index}] must be an Exposure record`);
  }

  const id = requiredString(exposure.id, `exposures[${index}].id`);
  const statement = requiredString(exposure.statement, `exposures[${index}].statement`);
  const eventAt = requiredString(exposure.eventAt, `exposures[${index}].eventAt`);
  const eventMs = Date.parse(eventAt);
  if (!Number.isFinite(eventMs)) {
    throw new Error(`exposures[${index}].eventAt must be a valid date`);
  }

  return {
    id,
    statement,
    eventAt: new Date(eventMs).toISOString(),
    eventMs,
    conversationId: conversationIdFor(exposure),
    human: Boolean(exposure.metadata?.human ?? exposure.human),
    signalWeight: finiteNumber(
      exposure.metadata?.signalWeight ?? exposure.signalWeight ?? 1,
      `exposures[${index}].signalWeight`,
    ),
    index,
  };
}

function conversationIdFor(exposure) {
  return optionalString(
    exposure.metadata?.conversationId ??
      exposure.conversationId ??
      exposure.conversation?.id,
  ) ?? '';
}

function compareItems(a, b) {
  return (
    a.eventMs - b.eventMs ||
    a.index - b.index ||
    a.id.localeCompare(b.id)
  );
}

function hardBoundary(previous, item, maxTemporalGapMs) {
  return (
    item.eventMs - previous.eventMs > maxTemporalGapMs ||
    item.conversationId !== previous.conversationId
  );
}

function bestThread(item, threads, { partition, threshold }) {
  let best = null;
  let bestSimilarity = threshold;

  for (const thread of threads) {
    if (thread.partition !== partition) continue;

    const similarity = cosineSimilarity(item.embedding, thread.centroid);
    if (
      similarity > bestSimilarity ||
      (similarity === bestSimilarity && best && thread.threadId < best.threadId)
    ) {
      best = thread;
      bestSimilarity = similarity;
    }
  }

  return best;
}

function createThread(item, { id, partition }) {
  return {
    threadId: id,
    theme: '',
    exposureIds: [item.id],
    window: {
      start: item.eventAt,
      end: item.eventAt,
    },
    centroid: item.embedding.slice(),
    items: [item],
    partition,
  };
}

function addToThread(thread, item) {
  thread.items.push(item);
  thread.exposureIds.push(item.id);
  thread.window.start = minIso(thread.window.start, item.eventAt);
  thread.window.end = maxIso(thread.window.end, item.eventAt);
  thread.centroid = averageEmbedding(thread.items);
}

function averageEmbedding(items) {
  const length = Math.max(...items.map((item) => item.embedding.length));
  const totals = Array.from({ length }, () => 0);
  let totalWeight = 0;

  for (const item of items) {
    const weight = Math.max(0, item.signalWeight);
    totalWeight += weight;
    for (let index = 0; index < length; index += 1) {
      totals[index] += (item.embedding[index] ?? 0) * weight;
    }
  }

  if (totalWeight === 0) return totals;
  return totals.map((value) => value / totalWeight);
}

function themeFor(items) {
  const selected = items.find((item) => item.human) ?? items[0];
  const terms = topTerms(items);
  if (terms.length > 0) return terms.map(titleCase).join(' ');

  const words = selected.statement
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9'-]/gi, ''))
    .filter(Boolean)
    .slice(0, 5);
  return words.length > 0 ? words.map(titleCase).join(' ') : 'Untitled Thread';
}

function topTerms(items) {
  const counts = new Map();
  const firstSeen = new Map();
  let ordinal = 0;

  for (const item of items) {
    const weight = Math.max(1, item.signalWeight);
    for (const term of termsFor(item.statement)) {
      if (!firstSeen.has(term)) {
        firstSeen.set(term, ordinal);
        ordinal += 1;
      }
      counts.set(term, (counts.get(term) ?? 0) + weight);
    }
  }

  return [...counts.entries()]
    .sort(([termA, countA], [termB, countB]) =>
      countB - countA ||
      firstSeen.get(termA) - firstSeen.get(termB) ||
      termA.localeCompare(termB))
    .slice(0, 3)
    .map(([term]) => term);
}

function termsFor(statement) {
  return statement
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9'-]{2,}/g)
    ?.filter((term) => !THEME_STOP_WORDS.has(term))
    .slice(0, 20) ?? [];
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function minIso(a, b) {
  return a <= b ? a : b;
}

function maxIso(a, b) {
  return a >= b ? a : b;
}

function embeddingOptions(opts) {
  const {
    maxTemporalGapMs,
    similarityThreshold,
    temporalGapMs,
    threshold,
    threadIdPrefix,
    ...embeddingOpts
  } = opts;
  return embeddingOpts;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a finite number`);
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) {
    throw new Error(`${label} must be non-negative`);
  }
  return number;
}
