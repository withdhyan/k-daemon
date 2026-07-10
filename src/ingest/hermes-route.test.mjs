import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../../daemon/server.mjs';
import { createStagedSkillsStore } from './hermes-staging.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { realTcpListenAvailable } from '../test-support/tcp.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

networkTest('GET /api/skills/staged lists pending skills and exposes full raw body on detail', async () => {
  const { server, request, dataDir } = await startTestServer();
  try {
    const staged = createStagedSkillsStore({ dataDir, now: fixedNow });
    const { record } = await staged.stageSkill(sampleSkill());

    const list = await (await request('GET', '/api/skills/staged')).json();
    assert.equal(list.pendingCount, 1);
    assert.equal(list.skills[0].name, 'substrate-query');
    // Summary must NOT include the full body.
    assert.equal(Object.hasOwn(list.skills[0], 'rawBody'), false);

    const detail = await (await request('GET', `/api/skills/staged/${record.skillId}`)).json();
    // Full raw SKILL.md body exposed for inspection (SEC-006).
    assert.equal(detail.rawBody.includes('THE FULL BODY'), true);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST decision approve/reject persists status; foreign code never activates', async () => {
  const { server, request, dataDir } = await startTestServer();
  try {
    const staged = createStagedSkillsStore({ dataDir, now: fixedNow });
    const { record } = await staged.stageSkill(sampleSkill());

    const approve = await postJson(request, '/api/skills/staged/decision', {
      skillId: record.skillId,
      decision: 'approve',
    });
    const body = await approve.json();
    assert.equal(approve.status, 200);
    assert.equal(body.status, 'approved');
    assert.equal(body.activated, false);

    const reload = createStagedSkillsStore({ dataDir, now: fixedNow });
    const persisted = await reload.readSkill(record.skillId);
    assert.equal(persisted.status, 'approved');
  } finally {
    await closeServer(server);
  }
});

networkTest('POST decision rejects unknown skill, bad decision, and client path fields', async () => {
  const { server, request } = await startTestServer();
  try {
    const unknown = await postJson(request, '/api/skills/staged/decision', {
      skillId: 'skl-000000000000000000000000',
      decision: 'approve',
    });
    assert.equal(unknown.status, 404);

    const badDecision = await postJson(request, '/api/skills/staged/decision', {
      skillId: 'skl-000000000000000000000000',
      decision: 'maybe',
    });
    assert.equal(badDecision.status, 400);

    const pathInjection = await postJson(request, '/api/skills/staged/decision', {
      skillId: 'skl-000000000000000000000000',
      decision: 'approve',
      path: '../../etc',
    });
    assert.equal(pathInjection.status, 400);
  } finally {
    await closeServer(server);
  }
});

function sampleSkill() {
  return {
    skillId: 'skl-abcdef012345abcdef012345',
    name: 'substrate-query',
    description: 'query substrate',
    version: '1.0.0',
    sourcePath: 'skills/substrate-query/SKILL.md',
    contentHash: 'a'.repeat(64),
    rawBody: '---\nname: substrate-query\n---\nTHE FULL BODY of the skill for inspection.',
    byteLength: 60,
    lineCount: 3,
    threatFlags: [],
  };
}

async function startTestServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-hermes-route-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  let server;
  try {
    server = await startServer({ store, dataDir, port: 0, now: fixedNow });
  } catch (error) {
    if (error.code === 'EPERM') {
      throw new Error('real TCP listen blocked by environment; server tests require listen(0)', {
        cause: error,
      });
    }
    throw error;
  }
  const address = server.address();
  return {
    server,
    dataDir,
    request: (method, pathname, body, headers) =>
      fetch(`http://127.0.0.1:${address.port}${pathname}`, { method, headers, body }),
  };
}

async function postJson(request, pathname, body) {
  return request('POST', pathname, JSON.stringify(body), { 'content-type': 'application/json' });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
