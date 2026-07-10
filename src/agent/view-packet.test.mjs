import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_DEPTH,
  VIEW_TYPES,
  applyPacketPatch,
  buildViewPacket,
  frontierExcludedForProvenance,
  validatePacketPatch,
  validateViewPacket,
} from './view-packet.mjs';

test('a leaf packet builds frozen and validates', () => {
  const packet = buildViewPacket({
    viewType: 'generic.card',
    text: 'state: ready. context: one contract. observation: typed packet. consider: render it.',
    provenance: { surface: 'public', lane: 'deliberate', plane: 'face', module: 'test' },
  });

  assert.match(packet.id, /^[0-9a-f]{24}$/);
  assert.equal(packet.viewType, 'generic.card');
  assert.equal(packet.frontierExcluded, false);
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.provenance), true);
  assert.equal(validateViewPacket(packet), packet);
});

test('a tree validates recursively', () => {
  const packet = buildViewPacket({
    viewType: 'generic.card',
    text: 'Parent packet',
    provenance: { surface: 'public' },
    children: [
      {
        viewType: 'generic.text',
        text: 'Child packet',
        provenance: { surface: 'public' },
      },
      {
        viewType: 'loop.evidence',
        text: 'Evidence child',
        evidence: ['exp_123', 'tool_456'],
        provenance: { surface: 'tool' },
      },
    ],
  });

  assert.equal(packet.children.length, 2);
  assert.equal(Object.isFrozen(packet.children), true);
  assert.equal(Object.isFrozen(packet.children[0]), true);
  assert.equal(validateViewPacket(packet), packet);
});

test('cycles are rejected at build and validation', () => {
  const cyclicInput = {
    viewType: 'generic.card',
    text: 'cycle',
    provenance: { surface: 'public' },
    children: [],
  };
  cyclicInput.children.push(cyclicInput);

  assert.throws(
    () => buildViewPacket(cyclicInput),
    /cycle detected/,
  );

  const cyclicPacket = {
    id: 'a'.repeat(24),
    viewType: 'generic.card',
    provenance: { surface: 'public' },
    frontierExcluded: false,
    children: [],
  };
  cyclicPacket.children.push(cyclicPacket);

  assert.throws(
    () => validateViewPacket(cyclicPacket),
    /cycle detected/,
  );
});

test('depth beyond DEFAULT_MAX_DEPTH is rejected', () => {
  const root = nestedPacketInput(DEFAULT_MAX_DEPTH + 1);

  assert.throws(
    () => buildViewPacket(root),
    /exceeds max depth/,
  );
});

test('unknown viewType is rejected at build', () => {
  assert.throws(
    () => buildViewPacket({
      viewType: 'generic.unknown',
      text: 'bad',
      provenance: { surface: 'public' },
    }),
    /unknown viewType: generic\.unknown/,
  );
});

test('id is deterministic for same content and changes for different content', () => {
  const first = buildViewPacket({
    viewType: 'generic.text',
    text: 'same content',
    provenance: { surface: 'public' },
  });
  const second = buildViewPacket({
    viewType: 'generic.text',
    text: 'same content',
    provenance: { surface: 'public' },
  });
  const changed = buildViewPacket({
    viewType: 'generic.text',
    text: 'different content',
    provenance: { surface: 'public' },
  });
  const scored = buildViewPacket({
    viewType: 'generic.text',
    text: 'same content',
    score: 0.3,
    provenance: { surface: 'public' },
  });

  assert.equal(first.id, second.id);
  assert.notEqual(first.id, changed.id);
  assert.equal(first.id, scored.id);
});

test('frontierExcluded defaults true for sensitive provenance and explicit true is honored', () => {
  const sensitive = buildViewPacket({
    viewType: 'k0.claim',
    text: 'private claim',
    provenance: { surface: 'biomarker', lane: 'ambient' },
  });
  const explicit = buildViewPacket({
    viewType: 'generic.text',
    text: 'public text held back',
    frontierExcluded: true,
    provenance: { surface: 'public' },
  });
  const unknown = buildViewPacket({
    viewType: 'generic.text',
    text: 'unknown provenance',
    provenance: { surface: 'novel-face' },
  });

  assert.equal(sensitive.frontierExcluded, true);
  assert.equal(explicit.frontierExcluded, true);
  assert.equal(unknown.frontierExcluded, true);
  assert.equal(frontierExcludedForProvenance({ provenance: { surface: 'web' } }), false);
});

test('K-card fields map onto ViewPacket fields without dropping data', () => {
  const packet = buildViewPacket({
    viewType: 'k0.decision',
    text: 'state: decision-ready. context: board card. observation: enough evidence. consider: pick.',
    nextAction: 'stage founder grant card',
    evidence: ['atom_1', 'exp_2'],
    siblings: ['cluster_a', 'decision_bar'],
    confidence: 0.86,
    provenance: {
      surface: 'mind-surface',
      lane: 'deliberate',
      plane: 'mind',
      module: 'deliberation',
    },
    surfaceDecision: {
      surface: true,
      reason: 'passed',
    },
  });

  assert.equal(packet.text.includes('decision-ready'), true);
  assert.deepEqual(packet.action, {
    kind: 'next_action',
    target: 'stage founder grant card',
  });
  assert.deepEqual(packet.evidence, ['atom_1', 'exp_2']);
  assert.deepEqual(packet.siblings, ['cluster_a', 'decision_bar']);
  assert.equal(packet.confidence, 0.86);
  assert.equal(packet.provenance.plane, 'mind');
  assert.equal(packet.provenance.module, 'deliberation');
  assert.deepEqual(packet.surfaceDecision, { surface: true, reason: 'passed' });
  assert.equal(packet.frontierExcluded, true);
});

test('k0-ui PRD aliases land in canonical packet homes', () => {
  const packet = buildViewPacket({
    viewType: 'k0.eval_score',
    status: 'passed',
    plane: 'eval',
    subject: 'A2UI packet contract',
    evidence_refs: ['eval_1'],
    contradiction_count: 0,
    rollback_ref: 'commit_before_u2',
    eval_score: 0.91,
    action: { kind: 'inspect_path', target: 'src/agent/view-packet.mjs' },
    provenance: { surface: 'internal', lane: 'deliberate' },
  });

  assert.equal(packet.fields.status, 'passed');
  assert.equal(packet.fields.plane, 'eval');
  assert.equal(packet.fields.subject, 'A2UI packet contract');
  assert.equal(packet.fields.contradiction_count, 0);
  assert.equal(packet.fields.rollback_ref, 'commit_before_u2');
  assert.deepEqual(packet.evidence, ['eval_1']);
  assert.equal(packet.score, 0.91);
  assert.deepEqual(packet.action, {
    kind: 'inspect_path',
    target: 'src/agent/view-packet.mjs',
  });
});

test('typed action intents add id intent and args without dropping legacy kind target', () => {
  const packet = buildViewPacket({
    viewType: 'preview.tool',
    text: 'Read memory',
    action: {
      id: 'read-focus',
      intent: 'memory.read',
      args: { key: 'focus' },
    },
    provenance: { surface: 'internal', lane: 'deliberate' },
  });

  assert.deepEqual(packet.action, {
    kind: 'memory.read',
    target: 'read-focus',
    id: 'read-focus',
    intent: 'memory.read',
    args: { key: 'focus' },
  });
});

test('typed action id and intent reject URL-shaped values', () => {
  assert.throws(
    () => buildViewPacket({
      viewType: 'preview.web',
      text: 'Bad action',
      action: {
        id: 'https://example.test/action',
        intent: 'memory.read',
        args: {},
      },
      provenance: { surface: 'public' },
    }),
    /action\.id must be an intent target, not a URL/,
  );
  assert.throws(
    () => buildViewPacket({
      viewType: 'preview.web',
      text: 'Bad action',
      action: {
        id: 'read',
        intent: 'www.example.test',
        args: {},
      },
      provenance: { surface: 'public' },
    }),
    /action\.kind must be an intent target, not a URL/,
  );
});

test('build status and card viewTypes validate', () => {
  const status = buildViewPacket({
    viewType: 'build.status',
    text: 'Build status update',
    fields: { seq: 1, status: 'building' },
    provenance: { surface: 'build' },
    frontierExcluded: true,
  });
  const card = buildViewPacket({
    viewType: 'build.card',
    text: 'Build card',
    fields: { seq: 2, cardId: 'card-1', status: 'raised' },
    provenance: { surface: 'build' },
    frontierExcluded: true,
  });

  assert.equal(validateViewPacket(status), status);
  assert.equal(validateViewPacket(card), card);
});

test('registry is closed and complete for U2', () => {
  assert.deepEqual(VIEW_TYPES, [
    'generic.card',
    'generic.table',
    'generic.chart',
    'generic.text',
    'k0.decision',
    'k0.provenance',
    'k0.claim',
    'k0.change',
    'k0.eval_score',
    'loop.evidence',
    'preview.file',
    'preview.web',
    'preview.tool',
    'build.status',
    'build.card',
  ]);
});

test('a set patch updates only the targeted packet field', () => {
  const packet = buildViewPacket({
    viewType: 'generic.text',
    text: 'Draft answer',
    fields: {
      status: 'streaming',
      subject: 'old subject',
    },
    provenance: { surface: 'public' },
  });
  const patch = {
    targetId: packet.id,
    ops: [{ op: 'set', field: 'fields.subject', value: 'new subject' }],
  };
  const logs = [];
  const logger = { warn: (message) => logs.push(message) };

  assert.equal(validatePacketPatch(patch), patch);
  const patched = applyPacketPatch(packet, patch, { logger });
  const appliedAgain = applyPacketPatch(patched, patch, { logger });

  assert.equal(validateViewPacket(patched), patched);
  assert.equal(patched.fields.subject, 'new subject');
  assert.equal(patched.fields.status, 'streaming');
  assert.equal(patched.text, 'Draft answer');
  assert.equal(patched.viewType, 'generic.text');
  assert.equal(appliedAgain, patched);
  assert.deepEqual(logs, []);
});

test('an append-child patch adds one child in order and is idempotent', () => {
  const packet = buildViewPacket({
    viewType: 'generic.text',
    text: 'Answer',
    provenance: { surface: 'public' },
  });
  const child = buildViewPacket({
    viewType: 'preview.web',
    text: 'Primary source',
    fields: { url: 'https://example.test/source' },
    provenance: { surface: 'web' },
  });
  const patch = {
    targetId: packet.id,
    ops: [{ op: 'append_child', child }],
  };
  const logs = [];
  const logger = { warn: (message) => logs.push(message) };

  const patched = applyPacketPatch(packet, patch, { logger });
  const appliedAgain = applyPacketPatch(patched, patch, { logger });

  assert.equal(validateViewPacket(patched), patched);
  assert.equal(patched.children.length, 1);
  assert.equal(patched.children[0].id, child.id);
  assert.equal(appliedAgain, patched);
  assert.deepEqual(logs, []);
});

test('a patch to an unknown packet id is ignored and logged', () => {
  const packet = buildViewPacket({
    viewType: 'generic.text',
    text: 'Answer',
    provenance: { surface: 'public' },
  });
  const logs = [];
  const logger = { warn: (message) => logs.push(message) };
  const patched = applyPacketPatch(packet, {
    targetId: 'f'.repeat(24),
    ops: [{ op: 'set', field: 'text', value: 'Hidden update' }],
  }, { logger });

  assert.equal(patched, packet);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unknown packet id/);
});

function nestedPacketInput(depth) {
  const root = {
    viewType: 'generic.card',
    text: `level ${depth}`,
    provenance: { surface: 'public' },
  };
  let current = root;
  for (let index = 1; index < depth; index += 1) {
    const child = {
      viewType: 'generic.text',
      text: `level ${depth - index}`,
      provenance: { surface: 'public' },
    };
    current.children = [child];
    current = child;
  }
  return root;
}
