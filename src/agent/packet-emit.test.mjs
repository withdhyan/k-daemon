import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnswerPacket,
  createAnswerPatchEmitter,
  viewTypeForContent,
} from './packet-emit.mjs';
import { buildViewPacket, validatePacketPatch, validateViewPacket } from './view-packet.mjs';

test('plain answer emits a validating generic.text packet', () => {
  const packet = buildAnswerPacket({
    content: 'Plain answer.',
    lane: 'frontier',
    sensitivity: 'public',
    sovereign: false,
    steps: 0,
    held: [],
  });

  assert.equal(viewTypeForContent({ content: 'Plain answer.' }), 'generic.text');
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.text');
  assert.equal(packet.text, 'Plain answer.');
  assert.equal(packet.frontierExcluded, false);
  assert.equal(packet.children, undefined);
  assert.deepEqual(packet.fields, {
    lane: 'frontier',
    sensitivity: 'public',
    sovereign: false,
    steps: 0,
    held: 0,
  });
});

test('citations emit preview.web children under the generic.text answer', () => {
  const packet = buildAnswerPacket({
    content: 'The answer uses two sources [1][2].',
    lane: 'frontier',
    sensitivity: 'public',
    sources: [
      {
        title: 'Primary source',
        url: 'https://example.test/primary',
        snippet: 'The primary evidence.',
      },
      'https://example.test/secondary',
    ],
  });

  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.text');
  assert.equal(packet.children.length, 2);
  assert.deepEqual(packet.children.map((child) => child.viewType), [
    'preview.web',
    'preview.web',
  ]);
  assert.equal(packet.children[0].text, 'Primary source');
  assert.equal(packet.children[0].fields.url, 'https://example.test/primary');
  assert.equal(packet.children[0].fields.snippet, 'The primary evidence.');
  assert.equal(packet.children[1].text, 'https://example.test/secondary');
  assert.equal(packet.children[1].fields.url, 'https://example.test/secondary');
  assert.equal(packet.children.every((child) => child.frontierExcluded === false), true);
});

test('sensitive answer provenance marks the packet frontierExcluded', () => {
  const packet = buildAnswerPacket(
    {
      content: 'Private answer.',
      lane: 'sovereign',
      sovereign: true,
    },
    { sensitivity: 'sensitive' },
  );

  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.text');
  assert.equal(packet.provenance.surface, 'verbatim-chat');
  assert.equal(packet.frontierExcluded, true);
});

test('memory.search tool results emit evidence packets with nested mind K-cards', () => {
  const mindCard = buildViewPacket({
    viewType: 'k0.change',
    text: 'state: EEG review. context: one evidence id. observation: bridge idea. consider: review.',
    fields: {
      outputId: 'mind_eeg_bridge',
      outputType: 'new_ideas',
      label: 'EEG review bridge',
      evidenceIds: ['exp_eeg_1'],
    },
    evidence: ['exp_eeg_1'],
    provenance: { surface: 'mind-surface', lane: 'sovereign', plane: 'mind', module: 'test' },
    frontierExcluded: true,
  });
  const packet = buildAnswerPacket({
    content: 'The memory trail points at the EEG artifact thread.',
    lane: 'sovereign',
    sensitivity: 'sensitive',
    sovereign: true,
    steps: 1,
    held: [],
    toolResults: [{
      toolId: 'memory.search',
      ok: true,
      sensitive: true,
      frontierExcluded: true,
      sensitivity: 'sensitive',
      provenance: ['substrate', 'exposure', 'mind-surface'],
      artifacts: {
        memorySearch: {
          query: 'EEG artifacts',
          exposures: [{
            id: 'exp_eeg_1',
            statement: 'ambient EEG artifact limits matter for the dhyan footprint',
            surface: 'claude',
            eventAt: '2026-07-01',
            score: 0.99,
          }],
          mindOutputs: [mindCard],
        },
      },
    }],
  });

  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.frontierExcluded, true);
  assert.equal(packet.children.length, 1);
  const evidence = packet.children[0];
  assert.equal(evidence.viewType, 'loop.evidence');
  assert.deepEqual(evidence.evidence, ['exp_eeg_1']);
  assert.equal(evidence.fields.exposures[0].id, 'exp_eeg_1');
  assert.equal(evidence.fields.citations[0].sourceId, 'exp_eeg_1');
  assert.equal(evidence.children[0].viewType, 'k0.change');
  assert.equal(evidence.children[0].fields.outputId, 'mind_eeg_bridge');
});

test('streaming answer emitter turns token deltas into text patches', () => {
  const stream = createAnswerPatchEmitter({
    lane: 'frontier',
    sensitivity: 'public',
    sovereign: false,
  }, { module: 'test' });

  const first = stream.pushToken('hi ');
  const second = stream.pushToken('there');

  assert.equal(validatePacketPatch(first), first);
  assert.equal(validatePacketPatch(second), second);
  assert.equal(first.ops[0].op, 'set');
  assert.equal(first.ops[0].field, 'text');
  assert.equal(first.ops[0].value, 'hi');
  assert.equal(second.ops[0].value, 'hi there');
  assert.equal(validateViewPacket(stream.packet), stream.packet);
  assert.equal(stream.packet.text, 'hi there');
});
