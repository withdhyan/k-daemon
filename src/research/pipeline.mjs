import {
  frontierExcludedRecordIds,
  frontierSafeRecords,
} from '../../daemon/run.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { embed, embedRecord } from './embed.mjs';
import {
  buildBlindSpotIndex,
  injectBlindSpots,
} from './argus.mjs';
import {
  checkNovelty,
  levyExplore,
} from './levy.mjs';
import {
  cosineSimilarity,
  vrsdSelect,
} from './vrsd.mjs';

export async function research(query, opts = {}) {
  const store = opts.store ?? createSubstrateStore(opts.storeOptions ?? storeOptions(opts));
  const allRecords = await store.listRecords();
  const excludedEvidenceIds = frontierExcludedRecordIds(allRecords);
  const embeddableRecords = allRecords.filter(isEmbeddableRecord);
  const records = recordFilter(opts.recordFilter, embeddableRecords, {
    allRecords,
    excludedEvidenceIds,
  });
  if (records.length === 0) return [];

  const embeddingOpts = embeddingOptions(opts);
  const queryEmbedding = opts.queryEmbedding ?? await embed(query, embeddingOpts);
  const allDocs = await embedRecords(records, embeddingOpts);
  if (allDocs.length === 0) return [];

  const k = positiveInteger(opts.k, 10);
  const candidateLimit = positiveInteger(opts.candidateLimit, 100);
  const vrsdIntermediate = positiveInteger(opts.vrsdIntermediate, Math.max(k, 20));
  const attentionState = normalizeAttentionState(opts.attentionState);

  const ranked = allDocs
    .map((doc) => ({
      ...doc,
      relevanceScore: cosineSimilarity(queryEmbedding, doc.embedding),
    }))
    .sort((a, b) =>
      b.relevanceScore - a.relevanceScore || String(a.id).localeCompare(String(b.id)));
  const candidates = ranked.slice(0, Math.min(candidateLimit, ranked.length));

  const blindSpotIndex = opts.blindSpotIndex ?? buildBlindSpotIndex(allDocs, {
    isolationThreshold: opts.isolationThreshold,
  });
  const argusPool = opts.argus === false
    ? candidates
    : injectBlindSpots(queryEmbedding, candidates, blindSpotIndex, {
      relevanceFloor: opts.relevanceFloor,
      maxInject: opts.maxInject,
    });
  const injectedIds = new Set(argusPool.slice(candidates.length).map((doc) => doc.id));

  const vrsdSelected = vrsdSelect(
    queryEmbedding,
    argusPool,
    Math.min(vrsdIntermediate, argusPool.length),
  );
  const explored = opts.levy === false
    ? []
    : levyExplore(
      queryEmbedding,
      allDocs,
      new Set(vrsdSelected.map((doc) => doc.id)),
      {
        frequency: opts.frequency,
        minDistance: opts.minDistance,
        nWalks: opts.levyWalks,
        random: opts.random,
      },
    );

  const selectedDocs = finalSelection(vrsdSelected, explored, k);
  const exploredIds = new Set(explored.map((doc) => doc.id));

  return selectedDocs.map((doc) =>
    evidenceItem(doc, {
      attentionState,
      exploredIds,
      injectedIds,
      noveltySatisfied: checkNovelty(vrsdSelected, explored),
      queryEmbedding,
    }));
}

export function evidenceGrade(relevanceScore) {
  if (relevanceScore >= 0.8) return 'L4';
  if (relevanceScore >= 0.6) return 'L3';
  if (relevanceScore >= 0.35) return 'L2';
  return 'L1';
}

function storeOptions(opts) {
  return {
    dataDir: opts.dataDir,
    now: opts.now,
  };
}

function embeddingOptions(opts) {
  const {
    embedder,
    testEmbedder,
    ...embeddingOpts
  } = opts;

  // testEmbedder is the pipeline's test-only injection seam; production uses embed().
  return testEmbedder
    ? { ...embeddingOpts, embedder: testEmbedder }
    : embeddingOpts;
}

function isEmbeddableRecord(record) {
  return record?.kind === 'Exposure' || record?.kind === 'SelfPattern';
}

function recordFilter(filter, records, context) {
  if (typeof filter === 'function') {
    const filtered = filter(records, context);
    if (!Array.isArray(filtered)) {
      throw new Error('research recordFilter must return an array');
    }
    return filtered;
  }

  return frontierSafeRecords(records, { excludedEvidenceIds: context.excludedEvidenceIds });
}

async function embedRecords(records, opts) {
  const docs = await Promise.all(records.map(async (record) => {
    const embedding = await embedRecord(record, opts);
    if (!Array.isArray(embedding) || embedding.length === 0) return null;

    return {
      id: record.id,
      embedding,
      content: recordContent(record),
      metadata: { kind: record.kind },
      record,
      relevanceScore: 0,
    };
  }));

  return docs.filter(Boolean);
}

function recordContent(record) {
  if (record.kind === 'Exposure') return record.statement;
  if (record.kind === 'SelfPattern') return record.pattern;
  return '';
}

function finalSelection(vrsdSelected, explored, k) {
  const selected = [];
  const seenIds = new Set();
  const uniqueExplored = uniqueDocs(explored);
  const vrsdSlots = Math.max(0, k - uniqueExplored.length);

  for (const doc of vrsdSelected.slice(0, vrsdSlots)) {
    pushUnique(selected, seenIds, doc);
  }
  for (const doc of uniqueExplored) {
    pushUnique(selected, seenIds, doc);
  }
  for (const doc of vrsdSelected) {
    if (selected.length >= k) break;
    pushUnique(selected, seenIds, doc);
  }

  return selected.slice(0, k);
}

function uniqueDocs(docs) {
  const selected = [];
  const seenIds = new Set();
  for (const doc of docs) {
    pushUnique(selected, seenIds, doc);
  }
  return selected;
}

function pushUnique(selected, seenIds, doc) {
  if (!doc || seenIds.has(doc.id)) return;
  seenIds.add(doc.id);
  selected.push(doc);
}

function evidenceItem(doc, context) {
  const relevanceScore = doc.relevanceScore ?? cosineSimilarity(context.queryEmbedding, doc.embedding);
  const source = context.exploredIds.has(doc.id)
    ? 'levy'
    : context.injectedIds.has(doc.id)
      ? 'argus'
      : 'vrsd';

  return {
    evidenceId: doc.id,
    evidenceIds: [doc.id],
    evidenceGrade: evidenceGrade(relevanceScore),
    source,
    relevanceScore,
    noveltySatisfied: context.noveltySatisfied,
    attentionState: context.attentionState,
    kind: doc.record.kind,
    content: doc.content,
    record: doc.record,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function normalizeAttentionState(value) {
  const state = String(value ?? 'neutral').toLowerCase();
  if (['neutral', 'divergent', 'convergent', 'breakthrough'].includes(state)) {
    return state;
  }
  return 'neutral';
}
