import { spawn } from 'node:child_process';
import path from 'node:path';

import { ROOT } from '../../daemon/run.mjs';
import {
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';

// UMAP+HDBSCAN over the real idea-atom corpus (thousands of 768-dim atoms) runs
// for minutes, not seconds; the old 60s default silently timed out and returned
// null, which dropped EVERY semantic output (themes/resurfaced/new-ideas) on a
// full `think`. The sidecar is a local batch step in the deliberate lane, so a
// multi-minute ceiling is acceptable. Override with K_MIND_CLUSTER_TIMEOUT_MS.
export const DEFAULT_CLUSTER_TIMEOUT_MS = 600_000;
export const DEFAULT_CLUSTER_PARAMS = Object.freeze({
  nNeighbors: 8,
  nComponents: 50,
  minDist: 0.0,
  metric: 'cosine',
  randomState: 42,
  minClusterSize: 3,
  minSamples: 2,
  clusterSelectionMethod: 'eom',
  mergeMinSimilarity: 0.72,
  mergeSmallClusterMaxSize: 12,
  bridgeK: 15,
  bridgeMinSimilarity: 0.5,
  bridgePairSimilarity: 0.65,
  bridgeLimit: 20,
  parentTargetCap: 8,
  resurfacedGapDays: 90,
  resurfacedRecentDays: 30,
});
const MAX_STDIO_BYTES = 10 * 1024 * 1024;

export async function clusterMindAtoms(atomDocs, opts = {}) {
  const atoms = normalizeClusterAtoms(atomDocs);
  if (atoms.length === 0) return emptyClusterResult();

  const pythonBin = optionalString(opts.pythonBin ?? process.env.K_MIND_CLUSTER_PYTHON) ??
    path.join(ROOT, '.venv-cluster', 'bin', 'python3');
  const scriptPath = optionalString(opts.scriptPath) ??
    path.join(ROOT, 'src', 'mind', 'cluster', 'cluster.py');
  const timeoutMs = positiveInteger(
    opts.timeoutMs ?? process.env.K_MIND_CLUSTER_TIMEOUT_MS,
    DEFAULT_CLUSTER_TIMEOUT_MS,
  );
  const params = {
    ...clusterParamsFromEnv(opts.env ?? process.env),
    ...(opts.params ?? {}),
  };
  const payload = JSON.stringify({ atoms, params });

  try {
    const { stdout } = await runSidecar({
      pythonBin,
      scriptPath,
      payload,
      timeoutMs,
    });
    return normalizeClusterResult(JSON.parse(stdout), { atomDocs: atoms, params });
  } catch (error) {
    logClusterNote(opts, `mind clustering sidecar unavailable; semantic outputs silenced (${error.message})`);
    return null;
  }
}

function runSidecar({ pythonBin, scriptPath, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONNOUSERSITE: process.env.PYTHONNOUSERSITE ?? '1',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_STDIO_BYTES && !settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('stdout exceeded limit'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_STDIO_BYTES && !settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('stderr exceeded limit'));
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = optionalString(stderr.trim()) ?? optionalString(signal);
        reject(new Error(`exited ${code ?? signal}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve({ stdout });
    });

    child.stdin.end(payload, 'utf8');
  });
}

function normalizeClusterAtoms(atomDocs) {
  if (!Array.isArray(atomDocs)) return [];
  return atomDocs
    .map((doc) => {
      const atom = doc?.atom ?? doc;
      const embedding = normalizeEmbedding(doc?.embedding ?? atom?.embedding);
      if (embedding.length === 0) return null;
      return stripUndefined({
        id: requiredString(doc?.id ?? atom?.id, 'IdeaAtom.id'),
        statement: requiredString(atom?.statement ?? doc?.statement, 'IdeaAtom.statement'),
        type: optionalString(atom?.type ?? doc?.type) ?? 'idea',
        embedding,
        eventAt: requiredString(doc?.eventAt ?? atom?.eventAt ?? atom?.validFrom, 'IdeaAtom.eventAt'),
        conversationId: optionalString(atom?.conversationId ?? doc?.conversationId),
      });
    })
    .filter(Boolean);
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

export function normalizeClusterResult(value, {
  atomDocs = [],
  params = DEFAULT_CLUSTER_PARAMS,
} = {}) {
  const rawResult = {
    leafClusters: arrayOfObjects(value?.leafClusters),
    parentThemes: arrayOfObjects(value?.parentThemes),
    resurfaced: arrayOfObjects(value?.resurfaced),
    newIdeaBridges: arrayOfObjects(value?.newIdeaBridges),
    noiseAtomIds: stringArray(value?.noiseAtomIds),
  };
  const mergedResult = mergeNearSmallSidecarClusters(rawResult, atomDocs, params);

  return Object.freeze({
    leafClusters: Object.freeze(mergedResult.leafClusters),
    parentThemes: Object.freeze(mergedResult.parentThemes),
    resurfaced: Object.freeze(mergedResult.resurfaced),
    newIdeaBridges: Object.freeze(mergedResult.newIdeaBridges),
    noiseAtomIds: Object.freeze(mergedResult.noiseAtomIds),
  });
}

function emptyClusterResult() {
  return normalizeClusterResult({
    leafClusters: [],
    parentThemes: [],
    resurfaced: [],
    newIdeaBridges: [],
    noiseAtomIds: [],
  });
}

function arrayOfObjects(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => optionalString(entry)).filter(Boolean).sort()
    : [];
}

export function clusterParamsFromEnv(env) {
  return Object.freeze({
    nNeighbors: envPositiveInteger(env.K_MIND_CLUSTER_N_NEIGHBORS, DEFAULT_CLUSTER_PARAMS.nNeighbors),
    nComponents: envPositiveInteger(env.K_MIND_CLUSTER_N_COMPONENTS, DEFAULT_CLUSTER_PARAMS.nComponents),
    minDist: envFiniteNumber(env.K_MIND_CLUSTER_MIN_DIST, DEFAULT_CLUSTER_PARAMS.minDist),
    metric: optionalString(env.K_MIND_CLUSTER_METRIC) ?? DEFAULT_CLUSTER_PARAMS.metric,
    randomState: envPositiveInteger(env.K_MIND_CLUSTER_RANDOM_STATE, DEFAULT_CLUSTER_PARAMS.randomState),
    minClusterSize: envPositiveInteger(
      env.K_MIND_CLUSTER_MIN_CLUSTER_SIZE,
      DEFAULT_CLUSTER_PARAMS.minClusterSize,
    ),
    minSamples: envPositiveInteger(env.K_MIND_CLUSTER_MIN_SAMPLES, DEFAULT_CLUSTER_PARAMS.minSamples),
    clusterSelectionMethod: optionalString(env.K_MIND_CLUSTER_CLUSTER_SELECTION_METHOD) ??
      DEFAULT_CLUSTER_PARAMS.clusterSelectionMethod,
    mergeMinSimilarity: boundedNumber(
      env.K_MIND_CLUSTER_MERGE_MIN_SIMILARITY,
      DEFAULT_CLUSTER_PARAMS.mergeMinSimilarity,
    ),
    mergeSmallClusterMaxSize: envPositiveInteger(
      env.K_MIND_CLUSTER_MERGE_SMALL_CLUSTER_MAX_SIZE,
      DEFAULT_CLUSTER_PARAMS.mergeSmallClusterMaxSize,
    ),
    bridgeK: envPositiveInteger(env.K_MIND_CLUSTER_BRIDGE_K, DEFAULT_CLUSTER_PARAMS.bridgeK),
    bridgeMinSimilarity: boundedNumber(
      env.K_MIND_CLUSTER_BRIDGE_MIN_SIMILARITY,
      DEFAULT_CLUSTER_PARAMS.bridgeMinSimilarity,
    ),
    bridgePairSimilarity: boundedNumber(
      env.K_MIND_CLUSTER_BRIDGE_PAIR_SIMILARITY,
      DEFAULT_CLUSTER_PARAMS.bridgePairSimilarity,
    ),
    bridgeLimit: envPositiveInteger(env.K_MIND_CLUSTER_BRIDGE_LIMIT, DEFAULT_CLUSTER_PARAMS.bridgeLimit),
    parentTargetCap: envPositiveInteger(
      env.K_MIND_CLUSTER_PARENT_TARGET_CAP,
      DEFAULT_CLUSTER_PARAMS.parentTargetCap,
    ),
    resurfacedGapDays: envPositiveInteger(
      env.K_MIND_CLUSTER_RESURFACED_GAP_DAYS,
      DEFAULT_CLUSTER_PARAMS.resurfacedGapDays,
    ),
    resurfacedRecentDays: envPositiveInteger(
      env.K_MIND_CLUSTER_RESURFACED_RECENT_DAYS,
      DEFAULT_CLUSTER_PARAMS.resurfacedRecentDays,
    ),
  });
}

function mergeNearSmallSidecarClusters(result, atomDocs, params) {
  const leafClusters = result.leafClusters;
  if (leafClusters.length < 2 || atomDocs.length === 0) return result;

  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const maxSize = positiveInteger(
    params.mergeSmallClusterMaxSize,
    DEFAULT_CLUSTER_PARAMS.mergeSmallClusterMaxSize,
  );
  const minSimilarity = boundedNumber(
    params.mergeMinSimilarity,
    DEFAULT_CLUSTER_PARAMS.mergeMinSimilarity,
  );
  const smallIndexes = new Set(leafClusters
    .map((cluster, index) => [cluster, index])
    .filter(([cluster]) => stringArray(cluster.atomIds).length <= maxSize)
    .filter(([cluster]) => stringArray(cluster.atomIds).some((id) => docsById.has(id)))
    .map(([, index]) => index));

  if (smallIndexes.size < 2 || minSimilarity <= 0) return result;

  const centroids = new Map();
  for (const index of smallIndexes) {
    centroids.set(index, normalizedMean(
      stringArray(leafClusters[index].atomIds)
        .map((id) => docsById.get(id)?.embedding)
        .filter(Array.isArray),
    ));
  }

  const adjacency = new Map([...smallIndexes].map((index) => [index, new Set()]));
  const indexes = [...smallIndexes].sort((a, b) => a - b);
  for (let outer = 0; outer < indexes.length; outer += 1) {
    for (let inner = outer + 1; inner < indexes.length; inner += 1) {
      const left = indexes[outer];
      const right = indexes[inner];
      if (cosineSimilarity(centroids.get(left), centroids.get(right)) < minSimilarity) continue;
      adjacency.get(left).add(right);
      adjacency.get(right).add(left);
    }
  }

  const visited = new Set();
  const groups = [];
  for (let index = 0; index < leafClusters.length; index += 1) {
    if (visited.has(index)) continue;
    visited.add(index);

    if (!smallIndexes.has(index)) {
      groups.push([index]);
      continue;
    }

    const stack = [index];
    const group = [];
    while (stack.length > 0) {
      const current = stack.pop();
      group.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    groups.push(group.sort((a, b) => a - b));
  }

  if (!groups.some((group) => group.length > 1)) return result;

  const clusterIdMap = new Map();
  const mergedLeafClusters = groups.map((group) => {
    const leaves = group.map((index) => leafClusters[index]);
    const merged = mergeLeafClusterGroup(leaves, docsById);
    for (const leaf of leaves) {
      const clusterId = optionalString(leaf.clusterId);
      if (clusterId) clusterIdMap.set(clusterId, merged.clusterId);
    }
    return merged;
  });

  return {
    leafClusters: mergedLeafClusters,
    parentThemes: normalizeParentThemes(result.parentThemes, clusterIdMap),
    resurfaced: normalizeClusterRefs(result.resurfaced, clusterIdMap, 'clusterId'),
    newIdeaBridges: normalizeBridgeRefs(result.newIdeaBridges, clusterIdMap),
    noiseAtomIds: result.noiseAtomIds,
  };
}

function mergeLeafClusterGroup(leaves, docsById) {
  const atomIds = orderedUnique(leaves.flatMap((leaf) => stringArray(leaf.atomIds)));
  const docs = atomIds.map((id) => docsById.get(id)).filter(Boolean);
  const keywords = orderedUnique(leaves.flatMap((leaf) => orderedStringList(leaf.keywords)));
  const label = firstPresentString(
    keywords.length > 0 ? keywords.slice(0, 5).join(' ') : undefined,
    ...leaves.map((leaf) => optionalString(leaf.label)),
    'recurring idea theme',
  );
  const clusterId = optionalString(leaves[0]?.clusterId) ?? `cluster_${atomIds[0] ?? 'merged'}`;
  const representativeAtomId = representativeAtomIdForDocs(docs) ??
    firstPresentString(...leaves.map((leaf) => leaf.representativeAtomId));

  return stripUndefined({
    clusterId,
    atomIds,
    representativeAtomId,
    label,
    keywords,
    members: docs.map((doc) => memberForDoc(doc)),
    mergedFromClusterIds: leaves.length > 1
      ? leaves.map((leaf) => optionalString(leaf.clusterId)).filter(Boolean)
      : undefined,
  });
}

function normalizeParentThemes(parentThemes, clusterIdMap) {
  return parentThemes.map((theme) => {
    const leafClusterIds = orderedUnique(stringArray(theme.leafClusterIds)
      .map((id) => clusterIdMap.get(id) ?? id));
    return {
      ...theme,
      leafClusterIds,
    };
  });
}

function normalizeClusterRefs(entries, clusterIdMap, key) {
  return entries.map((entry) => {
    const clusterId = optionalString(entry[key]);
    return clusterId && clusterIdMap.has(clusterId)
      ? { ...entry, [key]: clusterIdMap.get(clusterId) }
      : entry;
  });
}

function normalizeBridgeRefs(bridges, clusterIdMap) {
  return bridges
    .map((bridge) => ({
      ...bridge,
      connectsClusterIds: orderedUnique(stringArray(bridge.connectsClusterIds)
        .map((id) => clusterIdMap.get(id) ?? id)),
    }))
    .filter((bridge) => stringArray(bridge.connectsClusterIds).length >= 2);
}

function memberForDoc(doc) {
  const atom = doc.atom ?? doc;
  return stripUndefined({
    atomId: requiredString(doc.id ?? atom.id, 'cluster.member.atomId'),
    statement: truncate(optionalString(atom.statement ?? doc.statement), 240),
    type: optionalString(atom.type ?? doc.type),
    eventAt: optionalString(doc.eventAt ?? atom.eventAt ?? atom.validFrom),
    conversationId: optionalString(atom.conversationId ?? doc.conversationId),
  });
}

function representativeAtomIdForDocs(docs) {
  if (docs.length === 0) return undefined;
  if (docs.length === 1) return docs[0].id;
  const centroid = normalizedMean(docs.map((doc) => doc.embedding));
  return [...docs]
    .sort((left, right) =>
      cosineSimilarity(right.embedding, centroid) - cosineSimilarity(left.embedding, centroid) ||
      String(left.id).localeCompare(String(right.id)))
    [0]?.id;
}

function normalizedMean(vectors) {
  const clean = vectors
    .filter(Array.isArray)
    .map((vector) => vector.map((value) => Number(value)).filter((value) => Number.isFinite(value)));
  const maxDim = Math.max(0, ...clean.map((vector) => vector.length));
  if (maxDim === 0 || clean.length === 0) return [];
  const totals = Array.from({ length: maxDim }, () => 0);
  for (const vector of clean) {
    for (let index = 0; index < maxDim; index += 1) totals[index] += vector[index] ?? 0;
  }
  return normalizeVector(totals.map((value) => value / clean.length));
}

function cosineSimilarity(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  const length = Math.max(a.length, b.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return Number.isFinite(score) ? score : 0;
}

function normalizeVector(vector) {
  const values = Array.isArray(vector)
    ? vector.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  const norm = Math.sqrt(values.reduce((total, value) => total + (value * value), 0));
  if (norm === 0) return values.map(() => 0);
  return values.map((value) => value / norm);
}

function orderedUnique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = optionalString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function orderedStringList(values) {
  return Array.isArray(values)
    ? values.map((value) => optionalString(value)).filter(Boolean)
    : [];
}

function firstPresentString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function truncate(value, maxChars) {
  const text = optionalString(value);
  return text ? text.replace(/\s+/g, ' ').trim().slice(0, maxChars) : undefined;
}

function envPositiveInteger(value, fallback) {
  return positiveInteger(value, fallback);
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function envFiniteNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function logClusterNote(opts, message) {
  if (typeof opts.note === 'function') {
    opts.note(message);
    return;
  }
  if (typeof opts.logger?.warn === 'function') opts.logger.warn(`[cs-k] ${message}`);
}
