import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mindArtifacts,
  startServer,
} from '../daemon/server.mjs';
import { validateViewPacket } from './agent/view-packet.mjs';
import {
  MIND_OUTPUT_DIR,
  MIND_OUTPUT_GROUPS,
  boundLabel,
  think,
} from './mind/think.mjs';
import { createSubstrateStore } from './substrate.mjs';
import { realTcpListenAvailable } from './test-support/tcp.mjs';

const fixedNow = () => new Date('2026-06-29T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;
const DECISION_CARD_KEYS = [
  'asked',
  'assumed',
  'missing',
  'next',
  'pick',
  'read',
  'whatWouldChangeIt',
  'why',
];

networkTest('GET / returns 404 — web is not a K surface (founder decision 2026-07-05)', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/');
    assert.equal(response.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

networkTest('GET /api/artifacts/body returns HRV baselines and staged protocols', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedFootprintHrv(store, 44);

    const response = await request('GET', '/api/artifacts/body');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      baselines: {
        hrv: 44,
        hrvDrift: {
          latest: 44,
          baseline: 44,
          delta: 0,
          direction: 'flat',
          samples: 1,
        },
        samples: 1,
      },
      protocols: [],
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/artifacts/body is a silent 200 for an empty store', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/artifacts/body');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      baselines: {
        samples: 0,
      },
      protocols: [],
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/chat/context returns bounded projected substrate context', async () => {
  const { server, request, store, address } = await startTestServer();
  const secretStatement = 'SECRET_CHAT_CONTEXT_SENTENCE founder text must never cross this endpoint.';
  try {
    const exposure = await store.writeExposure({
      type: 'observation',
      statement: secretStatement,
      sourceId: 'chat-context-safe-source',
      eventAt: '2026-06-28T09:00:00.000Z',
      provenance: { surface: 'bookmarks', lane: 'deliberate' },
    });
    await store.processEngagement({
      exposureId: exposure.id,
      action: 'learned',
      pattern: 'Keep reversible local bridges visible',
      confidence: 0.76,
      eventAt: '2026-06-28T09:10:00.000Z',
    });
    const frontierExcludedExposure = await store.writeExposure({
      type: 'observation',
      statement: 'FRONTIER_EXCLUDED_CHAT_CONTEXT_SENTINEL exposure must stay absent.',
      sourceId: 'chat-context-frontier-excluded',
      eventAt: '2026-06-28T09:20:00.000Z',
      provenance: { surface: 'claude', lane: 'deliberate' },
    });
    await store.processEngagement({
      exposureId: frontierExcludedExposure.id,
      action: 'learned',
      pattern: 'FRONTIER_EXCLUDED_CHAT_CONTEXT_SENTINEL pattern must stay absent',
      confidence: 0.88,
      frontierExcluded: true,
      eventAt: '2026-06-28T09:25:00.000Z',
    });
    await store.writeGenomicTrait({
      rsid: 'rs-chat-context-private',
      chromosome: '1',
      position: '12345',
      genotype: 'GENOMIC_CHAT_CONTEXT_SENTINEL',
      trait: 'Private chat context trait',
      category: 'private',
      provenance: { surface: 'genome', lane: 'deliberate' },
    });
    await seedIdeaAtom(store.dataDir, {
      id: 'idea_chat_context',
      label: 'Use the bounded context bridge',
      statement: 'SECRET_IDEA_CONTEXT_SENTENCE raw mind atom text must stay absent.',
      eventAt: '2026-06-28T09:30:00.000Z',
    });
    await seedChatRecommendation(store.dataDir);

    const response = await request('GET', '/api/chat/context');
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.equal(address.address, '127.0.0.1');
    assert.deepEqual(body.context.exposures.map((item) => item.type), ['observation']);
    assert.equal(body.context.selfPatterns.length, 1);
    assert.equal(body.context.ideaAtoms[0].label, 'Use the bounded context bridge');
    assert.equal(body.context.recommendations[0].label, 'Ship the read-only chat bridge');
    assert.match(body.block, /## Recent exposures/);
    assert.match(body.block, /## Self patterns/);
    assert.match(body.block, /## Mind idea atoms/);
    assert.match(body.block, /## Staged recommendations/);
    assertNoRawChatContextFields(body.context);
    assert.doesNotMatch(text, /SECRET_CHAT_CONTEXT_SENTENCE/);
    assert.doesNotMatch(text, /FRONTIER_EXCLUDED_CHAT_CONTEXT_SENTINEL/);
    assert.doesNotMatch(text, /GENOMIC_CHAT_CONTEXT_SENTINEL/);
    assert.doesNotMatch(text, /SECRET_IDEA_CONTEXT_SENTENCE/);
    assert.doesNotMatch(text, /SECRET_RECOMMENDATION_REASON/);
    assert.doesNotMatch(text, /"statement"/);
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/chat/context is silent for an empty store', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/chat/context');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      context: {
        exposures: [],
        selfPatterns: [],
        ideaAtoms: [],
        recommendations: [],
      },
      block: '',
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('non-GET /api/chat/context is rejected', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await postJson(request, '/api/chat/context', { ok: true });

    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { ok: false, error: 'method_not_allowed' });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/artifacts/mind returns bounded four-group mind outputs', async () => {
  const { server, request, store } = await startTestServer();
  const secretThemeStatement = 'SECRET_THEME_SENTENCE_U6 The full parent theme evidence sentence must stay off the wire.';
  try {
    await seedIdeaAtom(store.dataDir, {
      outputGroups: [],
    });
    await seedMindOutput(store.dataDir, {
      outputId: 'mind_theme_local_viewer',
      kind: 'MindTheme',
      outputGroup: 'themes_open_loops',
      type: 'theme',
      statement: secretThemeStatement,
      summary: secretThemeStatement,
      observation: 'Viewer value and health review belong in one synthesized theme.',
      considerations: [
        'Separate the viewer value signal from unrelated artifact noise.',
        'Keep the next review step bounded to the source atoms.',
        'Trim this deliberately long consideration before it reaches the artifact wire because the model could produce a private planning paragraph that exceeds the card budget by a wide margin.',
      ],
      openLoop: true,
      openAtomIds: ['idea_local_viewer'],
    });
    await seedMindOutput(store.dataDir, {
      outputId: 'mind_resurfaced_viewer',
      kind: 'MindResurfacedIdea',
      label: 'Resurface the dormant viewer thread',
      summary: 'SECRET_RESURFACED_SENTENCE_U5 The full dormant thought must stay off the wire.',
      type: 'idea',
      outputGroup: 'resurfaced',
      observation: 'Dormant viewer work returned as a reviewable thread.',
      atomIds: ['idea_local_viewer'],
      evidenceIds: ['idea_local_viewer'],
    });
    await seedMindOutput(store.dataDir, {
      outputId: 'mind_new_viewer',
      kind: 'DivergentIdea',
      label: 'Try one narrow viewer comparison',
      rationale: 'SECRET_NEW_IDEA_SENTENCE_U5 The full generated thought must stay off the wire.',
      type: 'idea',
      outputGroup: 'new_ideas',
      observation: 'A narrow viewer comparison bridges the review thread.',
      atomIds: ['idea_local_viewer'],
      evidenceIds: ['idea_local_viewer'],
    });
    await seedMindCandidate(store.dataDir);

    const response = await request('GET', '/api/artifacts/mind');
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.deepEqual(body.outputSections.map((section) => section.key), MIND_OUTPUT_GROUPS);
    assert.deepEqual(body.outputSections.map((section) => section.label), [
      'Build / Execute / Decide',
      'Themes & Open Loops',
      'Resurfaced Ideas',
      'New Ideas',
    ]);
    assert.equal(body.build_decide.length, 1);
    assert.equal(body.themes_open_loops.length, 1);
    assert.equal(body.resurfaced.length, 1);
    assert.equal(body.new_ideas.length, 1);
    const candidatePacket = body.candidates[0];
    const themePacket = body.themes_open_loops[0];
    const resurfacedPacket = body.resurfaced[0];
    const newIdeaPacket = body.new_ideas[0];
    assert.equal(validateViewPacket(candidatePacket), candidatePacket);
    assert.equal(validateViewPacket(themePacket), themePacket);
    assert.equal(validateViewPacket(resurfacedPacket), resurfacedPacket);
    assert.equal(validateViewPacket(newIdeaPacket), newIdeaPacket);
    assert.equal(candidatePacket.viewType, 'k0.decision');
    assert.equal(themePacket.viewType, 'loop.evidence');
    assert.equal(candidatePacket.fields.outputId, path.join('decisions', 'mind-candidate.json'));
    assert.deepEqual(Object.keys(candidatePacket.fields.decisionCard).sort(), DECISION_CARD_KEYS);
    assert(candidatePacket.fields.decisionCard.why.length <= 221);
    assert(candidatePacket.fields.decisionCard.whatWouldChangeIt.length <= 221);
    assert.equal(body.ideaAtoms[0].outputId, 'idea_local_viewer');
    assert.equal(themePacket.fields.label, 'Local viewer confirms value');
    assert.equal(themePacket.fields.observation, 'Viewer value and health review belong in one synthesized theme.');
    assert.equal(themePacket.fields.openLoop, true);
    assert.deepEqual(themePacket.fields.openAtomIds, ['idea_local_viewer']);
    assert(themePacket.fields.considerations.every((entry) => entry.length <= 221));
    assert.equal(resurfacedPacket.fields.label, 'Resurface the dormant viewer thread');
    assert.equal(newIdeaPacket.fields.label, 'Try one narrow viewer comparison');
    assert.deepEqual(body.priorVerdicts, []);
    assert.equal(body.evalDate, '2026-06-29');
    assert.match(text, /Local viewer confirms value/);
    assert.match(text, /artifact-conversation/);
    assert.doesNotMatch(text, /SECRET_CHAT_SENTENCE_U4/);
    assert.doesNotMatch(text, /SECRET_THEME_SENTENCE_U6/);
    assert.doesNotMatch(text, /SECRET_RESURFACED_SENTENCE_U5/);
    assert.doesNotMatch(text, /SECRET_NEW_IDEA_SENTENCE_U5/);
    assert.doesNotMatch(text, /private candidate rationale/);
    assert.doesNotMatch(text, /PRIVATE_CARD_REASON_SHOULD_NOT_SURFACE/);
    assertNoRawMindFields(body);
  } finally {
    await closeServer(server);
  }
});

test('mindArtifacts surfaces bounded decisionCard fields for mind candidates without private rationale', async () => {
  const store = await freshStore();
  await seedIdeaAtom(store.dataDir);
  await seedMindCandidate(store.dataDir);

  const body = await mindArtifacts({ dataDir: store.dataDir, now: fixedNow });
  const text = JSON.stringify(body);
  const packet = body.candidates[0];
  const card = packet?.fields?.decisionCard;

  assert.equal(body.build_decide.length, 1);
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'k0.decision');
  assert.deepEqual(Object.keys(card).sort(), DECISION_CARD_KEYS);
  assert.deepEqual(
    DECISION_CARD_KEYS.map((key) => [key, packet.fields[key]]),
    DECISION_CARD_KEYS.map((key) => [key, card[key]]),
  );
  assert(Object.values(card).every((value) => value.length <= 221));
  assert.equal(card.asked, 'Should the local viewer stay in the build queue as a founder-reviewed candidate?');
  assert.doesNotMatch(text, /private candidate rationale/);
  assert.doesNotMatch(text, /PRIVATE_CARD_REASON_SHOULD_NOT_SURFACE/);
  assertNoRawMindFields(body);
});

test('mindArtifacts projects tagged mind output groups without raw statement leakage', async () => {
  const store = await freshStore();
  const secretThemeStatement = 'SECRET_DIRECT_THEME_SENTENCE_U6 The direct parent theme evidence sentence must stay off the wire.';

  await seedIdeaAtom(store.dataDir, {
    outputGroups: [],
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'mind_direct_theme',
    kind: 'MindTheme',
    type: 'theme',
    summary: secretThemeStatement,
    observation: 'Direct viewer value resolves into one reviewable theme.',
    considerations: [
      'Keep direct viewer evidence separate from generated bridge ideas.',
      'Use only source atom ids to carry the thread forward.',
    ],
    openLoop: true,
    openAtomIds: ['idea_local_viewer'],
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'mind_resurfaced_direct',
    kind: 'MindResurfacedIdea',
    label: 'Resurface the dormant direct thread',
    summary: 'SECRET_DIRECT_RESURFACED_SENTENCE_U6 The direct dormant thought must stay off the wire.',
    type: 'resurfaced',
    outputGroup: 'resurfaced',
    observation: 'The dormant direct thread returned for review.',
    atomIds: ['idea_local_viewer'],
    evidenceIds: ['idea_local_viewer'],
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'mind_new_direct',
    kind: 'DivergentIdea',
    label: 'Try one direct bridge comparison',
    rationale: 'SECRET_DIRECT_NEW_IDEA_SENTENCE_U6 The direct generated thought must stay off the wire.',
    type: 'idea',
    outputGroup: 'new_ideas',
    observation: 'One direct bridge comparison connects the theme.',
    atomIds: ['idea_local_viewer'],
    evidenceIds: ['idea_local_viewer'],
  });

  const body = await mindArtifacts({ dataDir: store.dataDir, now: fixedNow });
  const text = JSON.stringify(body);

  assert.equal(body.themes_open_loops.length, 1);
  assert.equal(body.resurfaced.length, 1);
  assert.equal(body.new_ideas.length, 1);
  assert.equal(validateViewPacket(body.themes_open_loops[0]), body.themes_open_loops[0]);
  assert.equal(body.themes_open_loops[0].viewType, 'loop.evidence');
  assert.equal(body.themes_open_loops[0].fields.label, 'Local viewer confirms value');
  assert.equal(
    body.themes_open_loops[0].fields.observation,
    'Direct viewer value resolves into one reviewable theme.',
  );
  assert.deepEqual(body.themes_open_loops[0].fields.considerations, [
    'Keep direct viewer evidence separate from generated bridge ideas.',
    'Use only source atom ids to carry the thread forward.',
  ]);
  assert.equal(body.themes_open_loops[0].fields.openLoop, true);
  assert.deepEqual(body.themes_open_loops[0].fields.openAtomIds, ['idea_local_viewer']);
  assert.equal(body.resurfaced[0].fields.label, 'Resurface the dormant direct thread');
  assert.equal(body.new_ideas[0].fields.label, 'Try one direct bridge comparison');
  assertNoRawMindFields(body);
  assert.doesNotMatch(text, /SECRET_DIRECT_THEME_SENTENCE_U6/);
  assert.doesNotMatch(text, /SECRET_DIRECT_RESURFACED_SENTENCE_U6/);
  assert.doesNotMatch(text, /SECRET_DIRECT_NEW_IDEA_SENTENCE_U6/);
});

test('mindArtifacts enriches output items with protocol fields and source siblings', async () => {
  const store = await freshStore();

  await seedIdeaAtom(store.dataDir, {
    id: 'idea_health_source_a',
    label: 'Cancer concern',
    statement: 'Cancer concern needs a concrete health review thread.',
    outputGroups: [],
  });
  await seedIdeaAtom(store.dataDir, {
    id: 'idea_health_source_b',
    label: 'Smoking risk',
    statement: 'Smoking risk belongs beside the cancer concern.',
    outputGroups: [],
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'idea_health_output',
    kind: 'MindTheme',
    label: 'Cancer smoking health risk',
    summary: 'This persisted output summary is not projected raw.',
    outputGroup: 'themes_open_loops',
    evidenceIds: ['idea_health_source_a', 'idea_health_source_b'],
    atomIds: ['idea_health_source_a', 'idea_health_source_b'],
    observation: 'Cancer concern and smoking risk form one health-review theme.',
    considerations: [
      'Separate screening concern from smoking-reduction action.',
      'Keep the first action a review, not an automatic intervention.',
    ],
    openLoop: true,
    openAtomIds: ['idea_health_source_a'],
    source: {
      kind: 'MindOutput',
      atomIds: ['idea_health_source_a', 'idea_health_source_b'],
    },
  });

  const body = await mindArtifacts({ dataDir: store.dataDir, now: fixedNow });
  const item = body.themes_open_loops.find((output) =>
    output.fields?.outputId === 'idea_health_output');

  assert(item);
  assert.equal(validateViewPacket(item), item);
  assert.equal(item.viewType, 'loop.evidence');
  // K's voice: entity leads, evidence support, ask — never the pipeline scaffold.
  assert.doesNotMatch(item.text, /^state: |context: |observation: |consider: /);
  assert.match(item.text, /^Cancer smoking health risk/);
  assert.match(item.text, /2 pieces of evidence/);
  assert.doesNotMatch(item.text, /2 atoms across 2 pieces/);
  assert.deepEqual(item.fields.sourceAtomIds, ['idea_health_source_a', 'idea_health_source_b']);
  assert.equal(item.fields.observation, 'Cancer concern and smoking risk form one health-review theme.');
  assert.deepEqual(item.fields.considerations, [
    'Separate screening concern from smoking-reduction action.',
    'Keep the first action a review, not an automatic intervention.',
  ]);
  assert.equal(item.fields.openLoop, true);
  assert.deepEqual(item.fields.openAtomIds, ['idea_health_source_a']);
  assert(item.evidence.includes('idea_health_source_a'));
  assert.equal(typeof item.fields.nextAction, 'string');
  assert.deepEqual(item.action, {
    kind: 'next_action',
    target: item.fields.nextAction,
  });
  assert(item.fields.siblings.length >= 2);
  assert(item.fields.siblings.every((sibling) => sibling.atomId && sibling.statement));
});

test('mindArtifacts projects synthesized mind-output themes instead of per-atom fragments', async () => {
  const store = await freshStore();

  await seedIdeaAtom(store.dataDir, {
    id: 'idea_fragment_a',
    label: 'Fragment A',
    statement: 'Raw fragment A must not become its own theme.',
    outputGroups: ['themes_open_loops'],
  });
  await seedIdeaAtom(store.dataDir, {
    id: 'idea_fragment_b',
    label: 'Fragment B',
    statement: 'Raw fragment B must not become its own theme.',
    outputGroups: ['themes_open_loops'],
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'mind_synthesized_theme',
    kind: 'MindTheme',
    label: 'One synthesized theme',
    outputGroup: 'themes_open_loops',
    observation: 'The two fragments collapse into one synthesized parent theme.',
    considerations: [
      'Keep the shared parent separate from raw atom fragments.',
      'Use merged atom ids for evidence and sibling context.',
    ],
    atomIds: ['idea_fragment_a', 'idea_fragment_b'],
    evidenceIds: ['idea_fragment_a', 'idea_fragment_b'],
    openLoop: true,
    openAtomIds: ['idea_fragment_a'],
  });

  const body = await mindArtifacts({ dataDir: store.dataDir, now: fixedNow });

  assert.equal(body.ideaAtoms.length, 2);
  assert.equal(body.themes_open_loops.length, 1);
  assert.equal(validateViewPacket(body.themes_open_loops[0]), body.themes_open_loops[0]);
  assert.equal(body.themes_open_loops[0].fields.outputId, 'mind_synthesized_theme');
  assert.equal(
    body.themes_open_loops[0].fields.observation,
    'The two fragments collapse into one synthesized parent theme.',
  );
  assert.deepEqual(body.themes_open_loops[0].fields.considerations, [
    'Keep the shared parent separate from raw atom fragments.',
    'Use merged atom ids for evidence and sibling context.',
  ]);
  assert.deepEqual(body.themes_open_loops[0].fields.atomIds, ['idea_fragment_a', 'idea_fragment_b']);
  assert.equal(body.themes_open_loops[0].fields.openLoop, true);
  assert.equal(body.outputSections.find((section) => section.key === 'themes_open_loops').items.length, 1);
});

networkTest('GET /api/artifacts/mind caps leaky idea-atom labels at the wire', async () => {
  const { server, request, store } = await startTestServer();
  const secretLabel = 'SECRET_LABEL_SENTENCE_U4FIX this label should not cross the artifact wire as a complete founder sentence';
  try {
    await seedIdeaAtom(store.dataDir, {
      id: 'idea_secret_label',
      label: secretLabel,
      statement: 'The statement is not projected by the mind artifact wire.',
      outputGroups: [],
    });

    const response = await request('GET', '/api/artifacts/mind');
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.equal(body.ideaAtoms[0].label, boundLabel(secretLabel));
    assert(body.ideaAtoms[0].label.length <= 80);
    assert(body.ideaAtoms[0].label.split(/\s+/).length <= 8);
    assert(!text.includes(secretLabel));
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/artifacts/mind caps candidate text derived from atom statements', async () => {
  const { server, request, store } = await startTestServer();
  const secretDecision = 'SECRET_DECISION_SENTENCE founder said this entire raw planning sentence must never cross the bounded mind wire';
  try {
    const first = await seedMindChatExposure(store, {
      statement: secretDecision,
      sourceId: 'secret-decision-a',
      eventAt: '2026-06-28T10:00:00.000Z',
      conversationId: 'secret-decision-conversation-a',
      turnIndex: 0,
    });
    const second = await seedMindChatExposure(store, {
      statement: 'A companion atom keeps the cluster above the candidate threshold.',
      sourceId: 'secret-decision-b',
      eventAt: '2026-06-28T10:01:00.000Z',
      conversationId: 'secret-decision-conversation-b',
      turnIndex: 0,
    });
    const atomsByExposureId = new Map([
      [first.id, { statement: secretDecision, type: 'question', confidence: 0.82 }],
      [second.id, {
        statement: 'A companion atom keeps the cluster above the candidate threshold.',
        type: 'idea',
        confidence: 0.78,
      }],
    ]);

    await think({
      dataDir: store.dataDir,
      store,
      now: fixedNow,
      modelCall: candidateLeakModelCall(atomsByExposureId),
      embedder: async () => [1, 0],
      clusterer: sidecarCandidateClusterer,
      segment: async () => [{
        threadId: 'secret-decision-cluster',
        theme: 'Untitled Idea Cluster',
        exposureIds: [first.id, second.id],
        window: {},
      }],
      logger: quietLogger(),
    });
    const decisions = await dataJsonFiles(store.dataDir, 'decisions');

    const response = await request('GET', '/api/artifacts/mind');
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, boundLabel(secretDecision));
    assert(decisions[0].recommended.length <= 80);
    assert(decisions[0].recommended.split(/\s+/).length <= 8);
    assert(!decisions[0].recommended.includes(secretDecision));
    assert.equal(response.status, 200);
    assert.equal(body.candidates.length, 1);
    assert.equal(validateViewPacket(body.candidates[0]), body.candidates[0]);
    assert.equal(body.candidates[0].fields.decision, boundLabel(secretDecision));
    assert(body.candidates[0].fields.decision.length <= 80);
    assert(body.candidates[0].fields.decision.split(/\s+/).length <= 8);
    assert(!text.includes(secretDecision));
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/artifacts/mind returns empty arrays when no mind artifacts exist', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/artifacts/mind');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ideaAtoms: [],
      candidates: [],
      build_decide: [],
      themes_open_loops: [],
      resurfaced: [],
      new_ideas: [],
      outputSections: [
        { key: 'build_decide', label: 'Build / Execute / Decide', items: [] },
        { key: 'themes_open_loops', label: 'Themes & Open Loops', items: [] },
        { key: 'resurfaced', label: 'Resurfaced Ideas', items: [] },
        { key: 'new_ideas', label: 'New Ideas', items: [] },
      ],
      priorVerdicts: [],
      evalDate: '2026-06-29',
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/artifacts/model returns counts and never emits genomic fields', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await store.writeGenomicTrait({
      rsid: 'rs-private-z9',
      chromosome: '9',
      position: '123456',
      genotype: 'PRIVATE-GENOTYPE-Z9',
      trait: 'Private trait',
      category: 'private',
      provenance: { surface: 'genome', lane: 'deliberate' },
    });

    const response = await request('GET', '/api/artifacts/model');
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.equal(body.counts.GenomicTrait, 1);
    assert.equal(body.counts.IdeaAtom, 0);
    assert.deepEqual(body.recentPatterns, []);
    assert.doesNotMatch(text, /rs-private-z9/);
    assert.doesNotMatch(text, /PRIVATE-GENOTYPE-Z9/);
    assert.doesNotMatch(text, /"rsid"/);
    assert.doesNotMatch(text, /"genotype"/);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/artifacts/mind/verdict persists, reads, and supersedes bounded verdicts', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedMindOutput(store.dataDir, {
      outputId: 'idea_eval_verdict',
      outputGroup: 'new_ideas',
      kind: 'DivergentIdea',
      label: 'Judge the bounded verdict target',
      summary: 'SECRET_EVAL_LOG_SENTENCE_U5 This raw statement must never enter the eval log.',
      type: 'idea',
    });

    const payload = {
      date: '2026-06-29',
      passId: '2026-06-29',
      outputType: 'new_ideas',
      outputId: 'idea_eval_verdict',
      verdict: 'act-on',
    };
    const first = await postJson(request, '/api/artifacts/mind/verdict', payload);
    const firstBody = await first.json();

    assert.equal(first.status, 200);
    assert.equal(firstBody.verdict.verdict, 'act-on');
    assert.equal(firstBody.verdict.label, 'Judge the bounded verdict target');

    const evalResponse = await request('GET', '/api/artifacts/eval?date=2026-06-29');
    const evalBody = await evalResponse.json();
    assert.equal(evalResponse.status, 200);
    assert.equal(evalBody.verdicts.length, 1);
    assert.equal(evalBody.verdicts[0].verdict, 'act-on');

    const nextPassResponse = await request('GET', '/api/artifacts/mind');
    const nextPassBody = await nextPassResponse.json();
    assert.equal(nextPassBody.priorVerdicts.length, 1);
    assert.equal(nextPassBody.priorVerdicts[0].verdict, 'act-on');

    const unknown = await postJson(request, '/api/artifacts/mind/verdict', {
      ...payload,
      verdict: 'maybe',
    });
    assert.equal(unknown.status, 400);

    const second = await postJson(request, '/api/artifacts/mind/verdict', {
      ...payload,
      verdict: 'nod',
    });
    assert.equal(second.status, 200);

    const fileText = await fs.readFile(
      path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'),
      'utf8',
    );
    const fileBody = JSON.parse(fileText);
    assert.equal(fileBody.verdicts.length, 1);
    assert.equal(fileBody.verdicts[0].verdict, 'nod');
    assert.equal(fileBody.verdicts[0].label, 'Judge the bounded verdict target');
    assert.doesNotMatch(fileText, /SECRET_EVAL_LOG_SENTENCE_U5/);
    assert.doesNotMatch(fileText, /statement/);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/artifacts/mind/verdict rejects client-controlled paths', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedMindOutput(store.dataDir, {
      outputId: 'idea_eval_path_guard',
      outputGroup: 'new_ideas',
      kind: 'DivergentIdea',
      label: 'Path guard verdict target',
    });
    const payload = {
      date: '2026-06-29',
      outputType: 'new_ideas',
      outputId: 'idea_eval_path_guard',
      verdict: 'junk',
    };

    const pathTarget = await postJson(request, '/api/artifacts/mind/verdict', {
      ...payload,
      path: '../../outside.json',
    });
    assert.equal(pathTarget.status, 400);

    const traversalDate = await postJson(request, '/api/artifacts/mind/verdict', {
      ...payload,
      date: '../outside',
    });
    assert.equal(traversalDate.status, 400);

    await assert.rejects(
      fs.readFile(path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await closeServer(server);
  }
});

networkTest('a corrupt eval log degrades to empty verdicts, never 500s the mind/eval read', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedMindOutput(store.dataDir, {
      outputId: 'idea_corrupt_guard',
      outputGroup: 'new_ideas',
      kind: 'DivergentIdea',
      label: 'Corrupt-log guard target',
    });
    // A corrupt/partial log, as an interrupted write or a hand-edit would leave.
    await fs.mkdir(path.join(store.dataDir, 'eval'), { recursive: true });
    await fs.writeFile(
      path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'),
      '{ "verdicts": [ {"passId": "2026-06-29", "outputTyp',
      'utf8',
    );

    const mind = await request('GET', '/api/artifacts/mind');
    const mindBody = await mind.json();
    assert.equal(mind.status, 200);
    assert.deepEqual(mindBody.priorVerdicts, []);

    const evalResponse = await request('GET', '/api/artifacts/eval?date=2026-06-29');
    const evalBody = await evalResponse.json();
    assert.equal(evalResponse.status, 200);
    assert.deepEqual(evalBody.verdicts, []);

    // The surface stays writable — a fresh verdict overwrites the corrupt log.
    const recovered = await postJson(request, '/api/artifacts/mind/verdict', {
      date: '2026-06-29',
      outputType: 'new_ideas',
      outputId: 'idea_corrupt_guard',
      verdict: 'act-on',
    });
    assert.equal(recovered.status, 200);
  } finally {
    await closeServer(server);
  }
});

networkTest('verdicts for distinct outputs on the same date both persist (no clobber)', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedMindOutput(store.dataDir, { outputId: 'idea_a', label: 'Output A', outputGroup: 'new_ideas', kind: 'DivergentIdea' });
    await seedMindOutput(store.dataDir, { outputId: 'idea_b', label: 'Output B', outputGroup: 'new_ideas', kind: 'DivergentIdea' });

    const base = { date: '2026-06-29', outputType: 'new_ideas' };
    const a = await postJson(request, '/api/artifacts/mind/verdict', { ...base, outputId: 'idea_a', verdict: 'act-on' });
    const b = await postJson(request, '/api/artifacts/mind/verdict', { ...base, outputId: 'idea_b', verdict: 'junk' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    const fileBody = JSON.parse(
      await fs.readFile(path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'), 'utf8'),
    );
    assert.equal(fileBody.verdicts.length, 2);
    const byId = Object.fromEntries(fileBody.verdicts.map((v) => [v.outputId, v.verdict]));
    assert.equal(byId.idea_a, 'act-on');
    assert.equal(byId.idea_b, 'junk');
  } finally {
    await closeServer(server);
  }
});

networkTest('verdict label comes from the server projection, not client input, and is re-bounded on read', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedMindOutput(store.dataDir, {
      outputId: 'idea_label_guard',
      outputGroup: 'new_ideas',
      kind: 'DivergentIdea',
      label: 'Bounded server label',
    });

    // A client trying to inject arbitrary text via `label` must be ignored —
    // the stored label is the server-side boundLabel(projection).
    const injected = await postJson(request, '/api/artifacts/mind/verdict', {
      date: '2026-06-29',
      outputType: 'new_ideas',
      outputId: 'idea_label_guard',
      verdict: 'nod',
      label: 'INJECTED_CLIENT_LABEL_U5 the founder privately decided something raw',
    });
    assert.equal(injected.status, 200);
    const injectedBody = await injected.json();
    assert.doesNotMatch(injectedBody.verdict.label, /INJECTED_CLIENT_LABEL_U5/);
    const afterInject = await fs.readFile(
      path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'), 'utf8',
    );
    assert.doesNotMatch(afterInject, /INJECTED_CLIENT_LABEL_U5/);

    // A hand-tampered log with a long raw sentence in `label` is re-bounded by
    // boundLabel on the GET read path — the far tail never returns verbatim.
    const tampered = {
      kind: 'MindEvalVerdictLog',
      schemaVersion: 1,
      date: '2026-06-29',
      verdicts: [{
        passId: '2026-06-29',
        date: '2026-06-29',
        outputType: 'new_ideas',
        outputId: 'idea_label_guard',
        label: 'one two three four five six seven eight nine ten ELEVEN_FARTAIL_U5 raw founder sentence tail',
        verdict: 'nod',
      }],
    };
    await fs.writeFile(
      path.join(store.dataDir, 'eval', 'mind-2026-06-29.json'),
      `${JSON.stringify(tampered, null, 2)}\n`, 'utf8',
    );

    const evalResponse = await request('GET', '/api/artifacts/eval?date=2026-06-29');
    const evalBody = await evalResponse.json();
    assert.equal(evalResponse.status, 200);
    assert.equal(evalBody.verdicts.length, 1);
    assert.doesNotMatch(JSON.stringify(evalBody), /ELEVEN_FARTAIL_U5/);
  } finally {
    await closeServer(server);
  }
});

async function startTestServer() {
  const store = await freshStore();
  let server;
  try {
    server = await startServer({ store, port: 0, now: fixedNow });
  } catch (error) {
    if (error.code === 'EPERM') {
      throw new Error('real TCP listen blocked by environment; server tests require listen(0)', {
        cause: error,
      });
    }
    throw error;
  }

  const address = server.address();
  assert.equal(typeof address, 'object');

  return {
    server,
    store,
    address,
    request: (method, pathname, body, headers) =>
      networkRequest(`http://127.0.0.1:${address.port}`, method, pathname, body, headers),
  };
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-artifacts-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function seedFootprintHrv(store, hrv) {
  await store.writeFootprintSample({
    sampleId: 'artifact-body-hrv',
    eventAt: '2026-06-29T00:00:00.000Z',
    provenance: { surface: 'body', lane: 'ambient' },
    phenomenology: {
      report: 'Artifact body baseline sample.',
    },
    physiology: {
      hrv,
    },
  });
}

async function seedIdeaAtom(dataDir, overrides = {}) {
  const dir = path.join(dataDir, 'substrate', 'idea-atoms');
  const record = {
    id: 'idea_local_viewer',
    kind: 'IdeaAtom',
    schemaVersion: 1,
    validFrom: fixedNow().toISOString(),
    validTo: null,
    eventAt: fixedNow().toISOString(),
    ingestedAt: fixedNow().toISOString(),
    supersededById: null,
    label: 'Local viewer confirms value',
    statement: 'SECRET_CHAT_SENTENCE_U4 The founder can see what Phase 4a produced.',
    type: 'observation',
    conversationId: 'artifact-conversation',
    confidence: 0.66,
    outputGroups: [],
    ...overrides,
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

async function seedMindOutput(dataDir, overrides = {}) {
  const outputGroup = overrides.outputGroup ?? 'themes_open_loops';
  const outputId = overrides.outputId ?? overrides.id ?? 'mind_local_viewer';
  const dir = path.join(dataDir, MIND_OUTPUT_DIR);
  const record = {
    id: outputId,
    kind: mindOutputKind(outputGroup),
    schemaVersion: 1,
    outputId,
    outputKey: outputId,
    contentHash: `fixture-${outputId}`,
    validFrom: fixedNow().toISOString(),
    validTo: null,
    eventAt: fixedNow().toISOString(),
    generatedAt: fixedNow().toISOString(),
    supersededById: null,
    label: 'Local viewer confirms value',
    outputGroup,
    outputType: outputGroup,
    observation: 'Viewer value and health review belong in one synthesized theme.',
    considerations: [],
    atomIds: ['idea_local_viewer'],
    evidenceIds: ['idea_local_viewer'],
    openLoop: false,
    confidence: 0.66,
    frontierExcluded: true,
    provenance: { surface: 'mind', lane: 'deliberate' },
    ...overrides,
  };
  if (!overrides.source) {
    record.source = {
      kind: 'MindOutput',
      outputGroup: record.outputGroup,
      outputKey: record.outputKey,
      atomIds: record.atomIds,
    };
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record.outputId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

function mindOutputKind(outputGroup) {
  if (outputGroup === 'resurfaced') return 'MindResurfacedIdea';
  if (outputGroup === 'new_ideas') return 'DivergentIdea';
  return 'MindTheme';
}

function assertNoRawMindFields(body) {
  const outputs = [...body.ideaAtoms];
  const packets = [
    ...body.candidates,
    ...body.build_decide,
    ...body.themes_open_loops,
    ...body.resurfaced,
    ...body.new_ideas,
    ...body.outputSections.flatMap((section) => section.items),
  ];

  for (const output of outputs) {
    assert(!Object.hasOwn(output, 'createdAt'));
  }
  for (const packet of packets) {
    assert.equal(validateViewPacket(packet), packet);
    assert(!Object.hasOwn(packet, 'outputId'));
    assert(!Object.hasOwn(packet, 'label'));
    assert(!Object.hasOwn(packet, 'statement'));
    assert(!Object.hasOwn(packet, 'evidenceIds'));
    assert(!Object.hasOwn(packet, 'sourceAtomIds'));
    assert(!Object.hasOwn(packet, 'nextAction'));
    assert(!Object.hasOwn(packet, 'decision'));
    assert(!Object.hasOwn(packet, 'decisionCard'));
    assert(!Object.hasOwn(packet, 'observation'));
    assert(!Object.hasOwn(packet, 'considerations'));
    assert(!Object.hasOwn(packet, 'openLoop'));
    assert(!Object.hasOwn(packet, 'openAtomIds'));
    assert(!Object.hasOwn(packet, 'createdAt'));
  }
}

function assertNoRawChatContextFields(context) {
  for (const output of [
    ...context.exposures,
    ...context.selfPatterns,
    ...context.ideaAtoms,
    ...context.recommendations,
  ]) {
    assert(!Object.hasOwn(output, 'statement'));
    assert(!Object.hasOwn(output, 'reason'));
    assert(!Object.hasOwn(output, 'recommended'));
    assert(!Object.hasOwn(output, 'protocol'));
    assert(!Object.hasOwn(output, 'metadata'));
    assert(!Object.hasOwn(output, 'dedupeKey'));
  }
}

async function dataJsonFiles(dataDir, relPath) {
  const dir = path.join(dataDir, relPath);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse)),
  );
}

async function seedMindCandidate(dataDir) {
  const dir = path.join(dataDir, 'decisions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'mind-candidate.json'),
    `${JSON.stringify({
      kind: 'LoopRecommendation',
      schemaVersion: 1,
      station: 'decide',
      acted: 'pending',
      advisoryOnly: true,
      surface: 'mind',
      decision: 'Decide whether the local viewer earns keeping.',
      recommended: 'Draft a reversible execution note for the local viewer.',
      reason: 'private candidate rationale must stay server-side PRIVATE_CARD_REASON_SHOULD_NOT_SURFACE',
      decisionCard: {
        asked: 'Should the local viewer stay in the build queue as a founder-reviewed candidate?',
        read: 'The card read the local viewer candidate and its bounded supporting evidence.',
        assumed: 'A small reversible viewer review is enough to validate whether the surface earns keeping.',
        missing: 'No material missing angle remains before the founder reviews this candidate.',
        pick: 'Keep one local viewer review candidate staged for the founder.',
        why: 'The bounded artifact evidence shows the viewer can expose useful local work without needing a broad redesign or any private rationale from the stored recommendation record.',
        whatWouldChangeIt: 'A newer artifact showing that the viewer cannot render the important local work would overturn this pick and move the item out of the queue.',
        next: 'Review the local viewer candidate and either keep it staged or archive it.',
      },
      reversibility: 'internal-revertible',
      tag: '[advise]',
      confidence: 0.72,
      createdAt: fixedNow().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  );
}

async function seedChatRecommendation(dataDir) {
  const dir = path.join(dataDir, 'decisions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'chat-context-recommendation.json'),
    `${JSON.stringify({
      kind: 'LoopRecommendation',
      schemaVersion: 1,
      station: 'decide',
      acted: 'pending',
      advisoryOnly: true,
      surface: 'local',
      decision: 'Ship the read-only chat bridge',
      recommended: 'Expose bounded context only',
      reason: 'SECRET_RECOMMENDATION_REASON raw rationale must stay absent',
      reversibility: 'internal-revertible',
      risk: 'low-stakes',
      tag: '[advise]',
      confidence: 0.8,
      createdAt: fixedNow().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  );
}

async function networkRequest(baseUrl, method, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body,
  });
}

async function postJson(request, pathname, payload) {
  return request(
    'POST',
    pathname,
    JSON.stringify(payload),
    { 'content-type': 'application/json' },
  );
}

async function seedMindChatExposure(store, {
  statement,
  sourceId,
  eventAt,
  conversationId,
  turnIndex,
}) {
  return store.writeExposure({
    type: 'observation',
    statement,
    sourceId,
    eventAt,
    context: conversationId,
    metadata: {
      conversationId,
      conversationName: 'Mind artifact fixture conversation',
      role: 'human',
      human: true,
      signalWeight: 2,
      turnIndex,
      messageId: sourceId,
    },
    provenance: { surface: 'claude', lane: 'deliberate' },
  });
}

function candidateLeakModelCall(atomsByExposureId) {
  return async (request) => {
    if (request.task === 'mind.divergentIdea') return {};

    const payload = JSON.parse(request.user);
    return {
      atoms: (payload.conversation.founderMessages ?? [])
        .map((message) => {
          const atom = atomsByExposureId.get(message.id);
          if (!atom) return null;
          return {
            ...atom,
            evidenceIds: [message.id],
          };
        })
        .filter(Boolean),
    };
  };
}

async function sidecarCandidateClusterer(atomDocs) {
  const atomIds = atomDocs.map((doc) => doc.id);
  return {
    leafClusters: [{
      clusterId: 'cluster_001',
      atomIds,
      representativeAtomId: atomIds[0],
      keywords: [],
    }],
    parentThemes: [],
    resurfaced: [],
    newIdeaBridges: [],
    noiseAtomIds: [],
  };
}

function quietLogger() {
  return { warn: () => {} };
}

async function closeServer(server) {
  if (!server.listening) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
