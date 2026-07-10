import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  AGUI_ACTION_INVOKE_TYPE,
  AGUI_PACKET_PATCH_EVENT,
  MAX_AGUI_BODY_BYTES,
  handleAguiMessage,
  isAguiPath,
} from '../daemon/routes/agui.mjs';
import { SovereignLaneError } from './agent/chat.mjs';
import { buildViewPacket, validatePacketPatch, validateViewPacket } from './agent/view-packet.mjs';

// A minimal mock ServerResponse that records SSE writes.
function mockResponse() {
  const chunks = [];
  return {
    statusCode: null,
    headers: null,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(String(chunk));
      this.writableEnded = true;
    },
    body() {
      return chunks.join('');
    },
    events() {
      return this.body()
        .split('\n\n')
        .filter(Boolean)
        .filter((block) => !block.startsWith(': '))
        .map((block) => {
          const lines = block.split('\n');
          const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
          return { event, data: data ? JSON.parse(data) : null };
        });
    },
  };
}

function mockRequest(payload) {
  const request = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  request.method = 'POST';
  request.url = '/api/agui/message';
  return request;
}

function mockRawRequest(raw) {
  const request = Readable.from([Buffer.from(raw, 'utf8')]);
  request.method = 'POST';
  request.url = '/api/agui/message';
  return request;
}

test('POST /api/agui/message streams a validated generic.text ViewPacket', async () => {
  const response = mockResponse();
  await handleAguiMessage(mockRequest({ message: 'hello' }), response, {
    runTurn: async ({ onToken }) => {
      onToken('hi ');
      onToken('there');
      return {
        content: 'hi there',
        lane: 'frontier',
        sensitivity: 'public',
        sovereign: false,
        steps: 0,
        held: [],
      };
    },
  });

  const events = response.events();
  const packets = events.filter((e) => e.event === 'packet');
  const packet = packets.at(-1)?.data;
  const patches = events.filter((e) => e.event === AGUI_PACKET_PATCH_EVENT);
  const firstPatchIndex = events.findIndex((e) => e.event === AGUI_PACKET_PATCH_EVENT);
  const finalPacketIndex = events.findLastIndex((e) => e.event === 'packet');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(packets.length, 2);
  assert.equal(validateViewPacket(packets[0].data), packets[0].data);
  assert.equal(patches.length, 2);
  assert.equal(firstPatchIndex < finalPacketIndex, true);
  assert.equal(validatePacketPatch(patches[0].data), patches[0].data);
  assert.equal(patches[0].data.targetId, packets[0].data.id);
  assert.equal(patches[0].data.ops[0].field, 'text');
  assert.equal(patches[0].data.ops[0].value, 'hi');
  assert.equal(patches[1].data.ops[0].value, 'hi there');
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.text');
  assert.equal(packet.text, 'hi there');
  assert.equal(packet.frontierExcluded, false);
  assert.equal(events.find((e) => e.event === 'done')?.data.ok, true);
});

test('POST /api/agui/message marks sensitive provenance frontierExcluded', async () => {
  const response = mockResponse();
  await handleAguiMessage(mockRequest({ message: 'private' }), response, {
    runTurn: async () => ({
      content: 'sovereign answer',
      lane: 'sovereign',
      sensitivity: 'sensitive',
      sovereign: true,
      provenance: { surface: 'biomarker', lane: 'sovereign', module: 'test' },
      steps: 0,
      held: [],
    }),
  });

  const packet = response.events().find((e) => e.event === 'packet')?.data;
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.text');
  assert.equal(packet.text, 'sovereign answer');
  assert.equal(packet.provenance.surface, 'biomarker');
  assert.equal(packet.frontierExcluded, true);
});

test('POST /api/agui/message passes the parsed message into substrate context assembly', async () => {
  const response = mockResponse();
  let builderMessage;
  let captured;

  await handleAguiMessage(mockRequest({ message: 'which substrate records matter?' }), response, {
    buildSubstrateBlock: async (userMessage) => {
      builderMessage = userMessage;
      return `EXPOSURE: relevant to ${userMessage}`;
    },
    runTurn: async (input) => {
      captured = input;
      return {
        content: 'ok',
        lane: 'sovereign',
        sensitivity: 'sensitive',
        sovereign: true,
        steps: 0,
        held: [],
      };
    },
  });

  assert.equal(builderMessage, 'which substrate records matter?');
  assert.equal(captured.substrateBlock, 'EXPOSURE: relevant to which substrate records matter?');
  assert.equal(captured.substratePresent, true);
});

test('SEC-002: sovereign-lane failure emits silence error, no packet or upstream echo', async () => {
  const response = mockResponse();
  await handleAguiMessage(mockRequest({ message: 'private' }), response, {
    runTurn: async () => {
      throw new SovereignLaneError('UPSTREAM_SECRET_FRAGMENT');
    },
  });

  const events = response.events();
  const error = events.find((e) => e.event === 'error');
  assert.equal(error.data.error, 'sovereign_lane_unavailable');
  assert.equal(error.data.silenced, true);
  assert.equal(events.some((e) => e.event === 'packet'), false);
  assert.equal(events.some((e) => e.event === 'done'), false);
  assert.ok(!response.body().includes('UPSTREAM_SECRET_FRAGMENT'));
});

test('SEC-002: default engine path does not frontier-fallback on sovereign failure', async () => {
  const response = mockResponse();
  const calls = { frontier: 0, sovereign: 0 };

  await handleAguiMessage(mockRequest({ message: 'private' }), response, {
    deps: {
      frontierModelCall: async () => {
        calls.frontier += 1;
        return 'FRONTIER_LEAK';
      },
      sovereignModelCall: async ({ onToken }) => {
        calls.sovereign += 1;
        onToken('partial sovereign text');
        throw new Error('UPSTREAM_SECRET_FRAGMENT');
      },
    },
  });

  const events = response.events();
  assert.equal(calls.sovereign, 1);
  assert.equal(calls.frontier, 0);
  assert.equal(events.find((e) => e.event === 'error')?.data.error, 'sovereign_lane_unavailable');
  assert.equal(events.some((e) => e.event === 'packet'), false);
  assert.equal(events.some((e) => e.event === AGUI_PACKET_PATCH_EVENT), false);
  assert.ok(!response.body().includes('FRONTIER_LEAK'));
  assert.ok(!response.body().includes('partial sovereign text'));
  assert.ok(!response.body().includes('UPSTREAM_SECRET_FRAGMENT'));
});

test('POST /api/agui/message rejects empty and invalid bodies with 400', async () => {
  const emptyResponse = mockResponse();
  await handleAguiMessage(mockRequest({ message: '' }), emptyResponse, {
    runTurn: async () => {
      throw new Error('should not run');
    },
  });
  assert.equal(emptyResponse.statusCode, 400);
  assert.ok(emptyResponse.body().includes('empty_message'));

  const invalidResponse = mockResponse();
  await handleAguiMessage(mockRawRequest('{bad json'), invalidResponse, {
    runTurn: async () => {
      throw new Error('should not run');
    },
  });
  assert.equal(invalidResponse.statusCode, 400);
  assert.ok(invalidResponse.body().includes('invalid_json'));
});

test('POST /api/agui/message rejects oversized bodies with 413', async () => {
  const response = mockResponse();
  await handleAguiMessage(mockRawRequest('x'.repeat(MAX_AGUI_BODY_BYTES + 1)), response, {
    runTurn: async () => {
      throw new Error('should not run');
    },
  });

  assert.equal(response.statusCode, 413);
  assert.ok(response.body().includes('body_too_large'));
});

test('action-invoke executes a read action through the governed loop and returns a result packet', async () => {
  const source = actionSourcePacket({
    action: {
      id: 'read-memory',
      intent: 'memory.read',
      args: { key: 'focus' },
    },
  });
  const response = mockResponse();
  const calls = [];

  await handleAguiMessage(mockRequest({
    type: AGUI_ACTION_INVOKE_TYPE,
    packetId: source.id,
    action: { id: 'read-memory', intent: 'memory.read' },
  }), response, {
    packets: [source],
    deps: {
      toolExecutor: async (id, args) => {
        calls.push({ id, args });
        return { ok: true, output: `memory ${args.key}=ship` };
      },
    },
  });

  const events = response.events();
  const packet = events.find((event) => event.event === 'packet')?.data;
  const done = events.find((event) => event.event === 'done')?.data;

  assert.deepEqual(calls, [{ id: 'memory.read', args: { key: 'focus' } }]);
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'preview.tool');
  assert.equal(packet.text, 'memory focus=ship');
  assert.equal(packet.fields.status, 'ok');
  assert.equal(packet.fields.intent, 'memory.read');
  assert.equal(packet.frontierExcluded, false);
  assert.equal(done.ok, true);
  assert.equal(done.status, 'ok');
  assert.equal(done.action.packetId, source.id);
  assert.equal(done.action.actionId, 'read-memory');
  assert.deepEqual(done.executed, [{ toolId: 'memory.read', ok: true, held: false }]);
});

test('action-invoke holds a mutating action with the chat tool-hold contract shape', async () => {
  const source = actionSourcePacket({
    action: {
      id: 'write-memory',
      intent: 'memory.write',
      args: { key: 'focus', value: 'ship' },
    },
  });
  const response = mockResponse();

  await handleAguiMessage(mockRequest({
    type: AGUI_ACTION_INVOKE_TYPE,
    packetId: source.id,
    action: { id: 'write-memory', intent: 'memory.write' },
  }), response, {
    packets: [source],
    deps: {
      toolExecutor: async () => {
        throw new Error('held mutating action must not execute');
      },
    },
  });

  const events = response.events();
  const packet = events.find((event) => event.event === 'packet')?.data;
  const done = events.find((event) => event.event === 'done')?.data;

  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.fields.status, 'held');
  assert.equal(packet.text, "I'm holding 1 action for your review (memory.write).");
  assert.deepEqual(packet.fields.held, [{ id: 'memory.write', reason: 'irreversible' }]);
  assert.deepEqual(done.held, [{ id: 'memory.write', reason: 'irreversible' }]);
  assert.equal(done.ok, false);
  assert.equal(done.status, 'held');
});

test('action-invoke on a frontierExcluded packet stays sovereign-only', async () => {
  const source = actionSourcePacket({
    frontierExcluded: true,
    provenance: { surface: 'verbatim-chat', lane: 'sovereign' },
    action: {
      id: 'private-read',
      intent: 'memory.read',
      args: { key: 'private' },
    },
  });
  const response = mockResponse();
  let frontierCalls = 0;
  let sawSovereignAction = false;

  await handleAguiMessage(mockRequest({
    type: AGUI_ACTION_INVOKE_TYPE,
    packetId: source.id,
    action: { id: 'private-read', intent: 'memory.read' },
  }), response, {
    packets: [source],
    runActionLoop: async (input) => {
      sawSovereignAction = input.sovereign === true;
      return {
        steps: 1,
        executed: [{ toolId: input.intent, ok: true, output: 'private result', sensitive: true }],
        held: [],
        finalOutput: '',
        sovereign: input.sovereign,
      };
    },
    deps: {
      frontierModelCall: async () => {
        frontierCalls += 1;
        return 'frontier';
      },
    },
  });

  const packet = response.events().find((event) => event.event === 'packet')?.data;
  assert.equal(sawSovereignAction, true);
  assert.equal(frontierCalls, 0);
  assert.equal(packet.frontierExcluded, true);
  assert.equal(packet.provenance.lane, 'sovereign');
});

test('action-invoke unknown packet id and unknown intent return error packets without crashing', async () => {
  const logs = [];
  const unknownPacketResponse = mockResponse();
  await handleAguiMessage(mockRequest({
    type: AGUI_ACTION_INVOKE_TYPE,
    packetId: '0'.repeat(24),
    action: { id: 'missing', intent: 'memory.read' },
  }), unknownPacketResponse, {
    logger: { warn: (message) => logs.push(message) },
    deps: {
      toolExecutor: async () => {
        throw new Error('unknown packet must not execute');
      },
    },
  });

  const unknownPacket = unknownPacketResponse.events().find((event) => event.event === 'packet')?.data;
  const unknownPacketDone = unknownPacketResponse.events().find((event) => event.event === 'done')?.data;
  assert.equal(validateViewPacket(unknownPacket), unknownPacket);
  assert.equal(unknownPacket.fields.status, 'error');
  assert.equal(unknownPacket.fields.code, 'unknown_packet_id');
  assert.equal(unknownPacketDone.ok, false);
  assert.equal(unknownPacketDone.error, 'unknown_packet_id');

  const source = actionSourcePacket({
    action: { id: 'known', intent: 'memory.read', args: { key: 'x' } },
  });
  const unknownIntentResponse = mockResponse();
  await handleAguiMessage(mockRequest({
    type: AGUI_ACTION_INVOKE_TYPE,
    packetId: source.id,
    action: { id: 'known', intent: 'memory.write' },
  }), unknownIntentResponse, {
    packets: [source],
    logger: { warn: (message) => logs.push(message) },
  });

  const unknownIntent = unknownIntentResponse.events().find((event) => event.event === 'packet')?.data;
  const unknownIntentDone = unknownIntentResponse.events().find((event) => event.event === 'done')?.data;
  assert.equal(validateViewPacket(unknownIntent), unknownIntent);
  assert.equal(unknownIntent.fields.status, 'error');
  assert.equal(unknownIntent.fields.code, 'unknown_intent');
  assert.equal(unknownIntentDone.ok, false);
  assert.equal(unknownIntentDone.error, 'unknown_intent');
  assert.ok(logs.some((message) => message.includes('unknown_packet_id')));
  assert.ok(logs.some((message) => message.includes('unknown_intent')));
});

test('isAguiPath recognizes AG-UI endpoints only', () => {
  assert.equal(isAguiPath('/api/agui/message'), true);
  assert.equal(isAguiPath('/api/agui/events'), true);
  assert.equal(isAguiPath('/api/chat'), false);
});

function actionSourcePacket({
  action,
  frontierExcluded = false,
  provenance = { surface: 'public', lane: 'deliberate' },
} = {}) {
  return buildViewPacket({
    viewType: 'preview.tool',
    text: 'Action source',
    action,
    provenance,
    frontierExcluded,
  });
}
