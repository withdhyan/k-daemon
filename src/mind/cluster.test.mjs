import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CLUSTER_PARAMS,
  clusterMindAtoms,
  clusterParamsFromEnv,
  normalizeClusterResult,
} from './cluster.mjs';

test('cluster defaults lower sidecar granularity', () => {
  assert.equal(DEFAULT_CLUSTER_PARAMS.minClusterSize, 3);
  assert.equal(DEFAULT_CLUSTER_PARAMS.minSamples, 2);
  assert.equal(DEFAULT_CLUSTER_PARAMS.nNeighbors, 8);
  assert.equal(DEFAULT_CLUSTER_PARAMS.mergeMinSimilarity, 0.72);
  assert.equal(DEFAULT_CLUSTER_PARAMS.mergeSmallClusterMaxSize, 12);
  assert.equal(DEFAULT_CLUSTER_PARAMS.parentTargetCap, 8);
});

test('cluster params are overridable from K_MIND_CLUSTER env values', () => {
  const params = clusterParamsFromEnv({
    K_MIND_CLUSTER_MIN_CLUSTER_SIZE: '4',
    K_MIND_CLUSTER_MIN_SAMPLES: '3',
    K_MIND_CLUSTER_N_NEIGHBORS: '6',
    K_MIND_CLUSTER_MERGE_MIN_SIMILARITY: '0.91',
    K_MIND_CLUSTER_PARENT_TARGET_CAP: '7',
  });

  assert.equal(params.minClusterSize, 4);
  assert.equal(params.minSamples, 3);
  assert.equal(params.nNeighbors, 6);
  assert.equal(params.mergeMinSimilarity, 0.91);
  assert.equal(params.parentTargetCap, 7);
});

test('cluster adapter merges near-centroid small clusters from mocked sidecar output', () => {
  const atomDocs = [
    syntheticAtomDoc('cancer-a', [1, 0], {
      statement: 'Cancer concern keeps coming up during health planning.',
    }),
    syntheticAtomDoc('cancer-b', [0.99, 0.01], {
      statement: 'Cancer screening anxiety needs a practical plan.',
    }),
    syntheticAtomDoc('cancer-c', [0.98, 0.02], {
      statement: 'Cancer risk should be handled as a concrete review.',
    }),
    syntheticAtomDoc('smoking-a', [0.97, 0.03], {
      statement: 'Smoking is the adjacent risk factor to resolve.',
    }),
    syntheticAtomDoc('smoking-b', [0.96, 0.04], {
      statement: 'Smoking and risk reduction belong in the same health thread.',
    }),
    syntheticAtomDoc('smoking-c', [0.95, 0.05], {
      statement: 'Smoking cessation should connect to the cancer concern.',
    }),
  ];
  const result = normalizeClusterResult({
    leafClusters: [
      {
        clusterId: 'cluster_001',
        atomIds: atomDocs.slice(0, 3).map((doc) => doc.id),
        representativeAtomId: atomDocs[0].id,
        keywords: ['cancer', 'concern'],
      },
      {
        clusterId: 'cluster_002',
        atomIds: atomDocs.slice(3).map((doc) => doc.id),
        representativeAtomId: atomDocs[3].id,
        keywords: ['smoking', 'risk'],
      },
    ],
    parentThemes: [],
    resurfaced: [],
    newIdeaBridges: [],
    noiseAtomIds: [],
  }, {
    atomDocs,
    params: {
      ...DEFAULT_CLUSTER_PARAMS,
      mergeMinSimilarity: 0.9,
      mergeSmallClusterMaxSize: 3,
    },
  });

  assert.equal(result.leafClusters.length, 1);
  assert.equal(result.leafClusters[0].atomIds.length, 6);
  assert.deepEqual(result.leafClusters[0].mergedFromClusterIds, ['cluster_001', 'cluster_002']);
  assert.match(result.leafClusters[0].label, /cancer concern smoking risk/);
  assert.notEqual(result.leafClusters[0].label, atomDocs[0].atom.statement);
  assert.equal(result.leafClusters[0].members.length, 6);
});

test('python sidecar clusters synthetic embedded atoms and returns parent themes deterministically', async (t) => {
  if (!await sidecarAvailable()) {
    t.skip('python clustering sidecar dependencies are unavailable');
    return;
  }

  const atomDocs = syntheticClusterAtomDocs();
  const options = {
    timeoutMs: 120_000,
    params: { now: '2026-06-28T00:00:00.000Z' },
    logger: quietLogger(),
  };

  const first = await clusterMindAtoms(atomDocs, options);
  const second = await clusterMindAtoms(atomDocs, options);

  assert(first);
  assert.deepEqual(second, first);
  assert(first.leafClusters.length >= 2);
  assert(first.parentThemes.length >= 1);
  assert(first.leafClusters.every((cluster) => cluster.atomIds.length >= 3));
  assert(first.parentThemes.every((theme) => theme.leafClusterIds.length >= 1));
});

test('cluster adapter returns null when python is unavailable', async () => {
  const result = await clusterMindAtoms([syntheticAtomDoc('probe', [1, 0, 0])], {
    pythonBin: '/missing/cs-k/python3',
    timeoutMs: 25,
    logger: quietLogger(),
  });

  assert.equal(result, null);
});

async function sidecarAvailable() {
  const result = await clusterMindAtoms([syntheticAtomDoc('availability', [1, 0, 0])], {
    timeoutMs: 5_000,
    logger: quietLogger(),
  });
  return result !== null;
}

function syntheticClusterAtomDocs() {
  const docs = [];
  const centers = [
    [1, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0],
  ];
  for (const [clusterIndex, center] of centers.entries()) {
    for (let index = 0; index < 18; index += 1) {
      const embedding = center.map((value, dim) =>
        value + deterministicJitter(clusterIndex, index, dim));
      docs.push(syntheticAtomDoc(
        `cluster-${clusterIndex}-${index}`,
        embedding,
        {
          statement: `Synthetic cluster ${clusterIndex} durable local topic ${index % 4}.`,
          eventAt: `2026-0${clusterIndex + 1}-${String((index % 18) + 1).padStart(2, '0')}T00:00:00.000Z`,
          conversationId: `conversation-${clusterIndex}-${index}`,
        },
      ));
    }
  }
  return docs;
}

function syntheticAtomDoc(id, embedding, overrides = {}) {
  const eventAt = overrides.eventAt ?? '2026-06-01T00:00:00.000Z';
  return {
    id: `idea_${id}`,
    embedding,
    eventAt,
    atom: {
      id: `idea_${id}`,
      label: `Synthetic ${id}`,
      statement: overrides.statement ?? `Synthetic atom ${id}.`,
      type: 'idea',
      confidence: 0.8,
      eventAt,
      validFrom: eventAt,
      conversationId: overrides.conversationId ?? `conversation-${id}`,
      evidenceIds: [`exp_${id}`],
    },
  };
}

function deterministicJitter(clusterIndex, index, dim) {
  return (((clusterIndex + 1) * 17 + (index + 1) * 7 + (dim + 1) * 3) % 11) / 1_000;
}

function quietLogger() {
  return { warn: () => {} };
}
