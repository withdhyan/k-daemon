import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  X_BOOKMARKS_SURFACE,
  ingestXBookmarksViaXurl,
  parseXurlBookmarks,
} from './x-bookmarks-xurl.mjs';

const SAMPLE_XURL_BOOKMARKS = {
  data: [
    {
      id: '1800000000000000001',
      text: 'Founder live bookmark.\nSecond line.',
      author_id: '42',
      created_at: '2026-06-10T20:19:24.000Z',
    },
    {
      id: '1800000000000000002',
      text: 'Fallback author URL.',
      author_id: 'missing-user',
      created_at: '2026-06-11T21:00:00.000Z',
    },
  ],
  includes: {
    users: [
      {
        id: '42',
        username: 'founder',
        name: 'Founder Example',
      },
    ],
  },
  meta: {
    result_count: 2,
  },
};

test('parseXurlBookmarks maps X API v2 bookmarks JSON to live entries', () => {
  assert.deepEqual(parseXurlBookmarks(SAMPLE_XURL_BOOKMARKS), [
    {
      id: '1800000000000000001',
      text: 'Founder live bookmark.\nSecond line.',
      authorHandle: 'founder',
      url: 'https://x.com/founder/status/1800000000000000001',
      createdAt: '2026-06-10T20:19:24.000Z',
    },
    {
      id: '1800000000000000002',
      text: 'Fallback author URL.',
      url: 'https://x.com/i/web/status/1800000000000000002',
      createdAt: '2026-06-11T21:00:00.000Z',
    },
  ]);
});

test('ingestXBookmarksViaXurl ingests fake xurl bookmarks through ingestWire dedup', async () => {
  const store = await freshStore();
  const calls = [];
  const runXurl = async (args) => {
    calls.push(args);
    if (args[0] === 'auth') return '\u25b8 default\n  oauth2: founder';
    if (args[0] === 'bookmarks') return JSON.stringify(SAMPLE_XURL_BOOKMARKS);
    throw new Error(`unexpected xurl args: ${args.join(' ')}`);
  };

  const first = await ingestXBookmarksViaXurl({ store, n: 2, runXurl });
  const second = await ingestXBookmarksViaXurl({ store, n: 2, runXurl });

  assert.deepEqual(calls, [
    ['auth', 'status'],
    ['bookmarks', '-n', '2'],
    ['auth', 'status'],
    ['bookmarks', '-n', '2'],
  ]);
  assert.equal(first.skipped, false);
  assert.equal(first.surface, X_BOOKMARKS_SURFACE);
  assert.equal(first.createdCount, 2);
  assert.equal(first.duplicateCount, 0);
  assert.equal(first.exposures.length, 2);
  assert.equal(first.exposures[0].statement, 'Founder live bookmark. Second line.');
  assert.equal(first.exposures[0].context, 'founder');
  assert.deepEqual(first.exposures[0].provenance, {
    surface: X_BOOKMARKS_SURFACE,
    lane: 'deliberate',
  });
  assert.deepEqual(first.exposures[0].metadata, {
    url: 'https://x.com/founder/status/1800000000000000001',
    authorHandle: 'founder',
  });
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 2);
  assert.equal(await store.countRecords('Exposure'), 2);
});

test('ingestXBookmarksViaXurl soft-skips when xurl is not installed', async () => {
  const store = await freshStore();
  const enoent = new Error('spawn xurl ENOENT');
  enoent.code = 'ENOENT';

  const result = await ingestXBookmarksViaXurl({
    store,
    runXurl: async () => {
      throw enoent;
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'xurl-not-installed');
  assert.equal(result.createdCount, 0);
  assert.deepEqual(result.exposures, []);
  assert.equal(await store.countRecords('Exposure'), 0);
});

test('ingestXBookmarksViaXurl soft-skips empty and no-auth status output', async () => {
  const emptyStatusCalls = [];
  const emptyStatus = await ingestXBookmarksViaXurl({
    store: await freshStore(),
    runXurl: async (args) => {
      emptyStatusCalls.push(args);
      return '';
    },
  });

  const noAuthCalls = [];
  const noAuth = await ingestXBookmarksViaXurl({
    store: await freshStore(),
    runXurl: async (args) => {
      noAuthCalls.push(args);
      return '\u25b8 default\n  oauth2: (none)';
    },
  });

  assert.equal(emptyStatus.skipped, true);
  assert.equal(emptyStatus.reason, 'no-auth');
  assert.deepEqual(emptyStatusCalls, [['auth', 'status']]);
  assert.equal(noAuth.skipped, true);
  assert.equal(noAuth.reason, 'no-auth');
  assert.deepEqual(noAuthCalls, [['auth', 'status']]);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-x-bookmarks-xurl-data-'));
  return createSubstrateStore({
    dataDir,
    now: () => new Date('2026-07-04T00:00:00.000Z'),
  });
}
