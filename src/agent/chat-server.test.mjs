import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../../daemon/server.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { realTcpListenAvailable } from '../test-support/tcp.mjs';
import { addNote } from './notes.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

networkTest('GET /api/chat is 405 (method not allowed) — the streaming route is POST-only', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/chat');
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { ok: false, error: 'method_not_allowed' });
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/chat with an empty message is rejected 400 before any model call', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('POST', '/api/chat', JSON.stringify({ message: '' }), {
      'content-type': 'application/json',
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.ok(body.includes('empty_message'));
  } finally {
    await closeServer(server);
  }
});

networkTest('the chat route keeps the loopback bind invariant', async () => {
  const { server, address } = await startTestServer();
  try {
    assert.equal(address.address, '127.0.0.1');
    assert.notEqual(address.address, '0.0.0.0');
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/chat injects notes after the skills index and before substrate', async () => {
  let captured;
  let substrateBlock;
  const { server, request, dataDir } = await startTestServer({
    chatHandler: async (_request, response, ctx) => {
      captured = ctx;
      substrateBlock = await ctx.buildSubstrateBlock();
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
    },
  });
  try {
    await addNote('Remember approved notes are injected after skills.', { dataDir });
    const response = await request('POST', '/api/chat', JSON.stringify({ message: 'hello' }), {
      'content-type': 'application/json',
    });

    assert.equal(response.status, 200);
    assert.match(captured.baseSystemPrompt, /## K soul document/);
    assert.match(captured.baseSystemPrompt, /sha256: [a-f0-9]{64}/);
    assert.match(captured.baseSystemPrompt, /## Skills/);
    assert.match(captured.baseSystemPrompt, /## K operational notes/);
    assert(captured.baseSystemPrompt.indexOf('You are K') < captured.baseSystemPrompt.indexOf('## K soul document'));
    assert(captured.baseSystemPrompt.indexOf('## K soul document') < captured.baseSystemPrompt.indexOf('## Skills'));
    assert(captured.baseSystemPrompt.indexOf('## Skills') < captured.baseSystemPrompt.indexOf('## K operational notes'));
    assert.equal(typeof captured.buildSubstrateBlock, 'function');
    assert.equal(substrateBlock.includes('## K operational notes'), false);
    assert.equal(substrateBlock.includes('## K soul document'), false);
  } finally {
    await closeServer(server);
  }
});

async function startTestServer(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-agent-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  let server;
  try {
    server = await startServer({ store, dataDir, port: 0, now: fixedNow, ...options });
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
    address,
    dataDir,
    request: (method, pathname, body, headers) =>
      networkRequest(`http://127.0.0.1:${address.port}`, method, pathname, body, headers),
  };
}

function networkRequest(origin, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, origin);
    const req = http.request(
      url,
      { method, headers: headers ?? {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
