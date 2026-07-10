import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { startServer } from '../../daemon/server.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { realTcpListenAvailable } from '../test-support/tcp.mjs';
import { readNoteEntries } from './notes.mjs';
import {
  PENDING_NOTES_DECISION_PATH,
  approvePendingNoteProposal,
  handlePendingNotesRoute,
  stagePendingNoteProposal,
} from './notes-pending.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

test('approving a pending note proposal applies the replayable payload', async () => {
  const dataDir = await tempDataDir();
  const staged = await stagePendingNoteProposal({
    origin: 'self_review',
    payload: { action: 'add', text: 'Use terse citations in web answers.' },
    evidence: ['K should use terse citations'],
  }, { dataDir, now: fixedNow });

  const approved = await approvePendingNoteProposal(staged.record.proposalId, { dataDir, now: fixedNow });

  assert.equal(approved.record.status, 'approved');
  assert.equal(approved.applied, true);
  assert.deepEqual(await readNoteEntries({ dataDir }), ['Use terse citations in web answers.']);
});

test('pending notes decision handler denies non-same-machine requests', async () => {
  const dataDir = await tempDataDir();
  const response = mockResponse();

  const handled = await handlePendingNotesRoute(
    Readable.from([Buffer.from('{}')]),
    response,
    { method: 'POST', pathname: PENDING_NOTES_DECISION_PATH, dataDir, now: fixedNow },
    {
      sendJson,
      httpError,
      readPlaintextJson: async () => {
        throw new Error('body should not be read when gate fails');
      },
      isSameMachine: () => false,
    },
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'loopback_required' });
});

networkTest('daemon registers pending notes list and decision routes', async () => {
  const { server, request, dataDir } = await startTestServer();
  try {
    const staged = await stagePendingNoteProposal({
      origin: 'self_review',
      payload: { action: 'add', text: 'Remember approved notes are injected after skills.' },
      evidence: ['approved notes are injected'],
    }, { dataDir, now: fixedNow });

    const list = await (await request('GET', '/api/notes/pending')).json();
    assert.equal(list.pendingCount, 1);
    assert.equal(list.notes[0].proposalId, staged.record.proposalId);

    const approve = await request('POST', PENDING_NOTES_DECISION_PATH, {
      proposalId: staged.record.proposalId,
      decision: 'approve',
    });
    assert.equal(approve.status, 200);
    assert.deepEqual(await readNoteEntries({ dataDir }), [
      'Remember approved notes are injected after skills.',
    ]);
  } finally {
    await closeServer(server);
  }
});

async function startTestServer() {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const server = await startServer({ store, dataDir, port: 0, now: fixedNow });
  const address = server.address();
  return {
    server,
    dataDir,
    request: (method, pathname, body) =>
      fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-pending-notes-'));
}

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      this.body = body;
    },
  };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
