import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../../daemon/server.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { realTcpListenAvailable } from '../test-support/tcp.mjs';

const fixedNow = () => new Date('2026-07-03T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

networkTest('boot smoke: real server GET surfaces and POST chat wiring stay alive', async () => {
  const { server, request } = await startSmokeServer();
  try {
    const getRoutes = [
      ['/api/health', (body) => assert.deepEqual(body, { ok: true })],
      ['/api/metrics', (body) => {
        assert.equal(body.ok, true);
        assert(Array.isArray(body.lanes));
      }],
      ['/api/sources', (body) => assert(Array.isArray(body))],
      ['/api/routines', (body) => assert(Array.isArray(body.routines))],
      ['/api/artifacts/mind', (body) => {
        assert(Array.isArray(body.outputSections));
        assert(Array.isArray(body.build_decide));
        assert(Array.isArray(body.themes_open_loops));
        assert(Array.isArray(body.resurfaced));
        assert(Array.isArray(body.new_ideas));
      }],
      ['/api/chat/context', (body) => {
        assert.equal(body.source, 'cs-k');
        assert.equal(typeof body.block, 'string');
        assert(Array.isArray(body.context.exposures));
        assert(Array.isArray(body.context.selfPatterns));
        assert(Array.isArray(body.context.ideaAtoms));
        assert(Array.isArray(body.context.recommendations));
      }],
    ];

    for (const [pathname, assertShape] of getRoutes) {
      const response = await request('GET', pathname);
      assert.equal(response.status, 200, pathname);
      assertShape(await response.json());
    }

    const chat = await request(
      'POST',
      '/api/chat',
      JSON.stringify({ message: 'smoke test' }),
      { 'content-type': 'application/json' },
    );
    assert.equal(chat.status, 200);
    const events = parseSseEvents(await chat.text());
    assert.deepEqual(events.filter((event) => event.event === 'token').map((event) => event.data.text), ['smoke token']);
    const done = events.find((event) => event.event === 'done');
    assert.equal(done.data.ok, true);
    assert.equal(done.data.content, 'smoke token');
    assert.equal(done.data.lane, 'sovereign');
  } finally {
    await closeServer(server);
  }
});

async function startSmokeServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-boot-smoke-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const server = await startServer({
    store,
    dataDir,
    port: 0,
    now: fixedNow,
    chatDeps: {
      frontierModelCall: async () => {
        throw new Error('frontier must not run during sovereign smoke');
      },
      sovereignModelCall: async ({ onToken }) => {
        onToken('smoke token');
        return 'smoke token';
      },
    },
  });
  const address = server.address();
  return {
    server,
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

function parseSseEvents(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
