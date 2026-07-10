import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gatherContext } from '../../daemon/run.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import {
  X_BOOKMARKS_SURFACE,
  X_BOOKMARK_STATEMENT_MAX_CHARS,
  extractXBookmarks,
  ingestXBookmarks,
  parseXBookmarksJson,
  xBookmarkExposureRecords,
} from './x-bookmarks.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');

test('X bookmarks parser accepts variant tweet shapes and bounds statements', async (t) => {
  const store = await freshStore();
  const file = await writeJsonFile(t, xBookmarksFixture());

  const payload = parseXBookmarksJson(await fs.readFile(file, 'utf8'), file);
  const bookmarks = extractXBookmarks(payload);
  const records = xBookmarkExposureRecords(payload);
  const result = await ingestXBookmarks({ store, file });
  const exposures = result.exposures.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const longExposure = exposures.find((record) => record.metadata.tweetId === '222');

  assert.equal(bookmarks.length, 3);
  assert.equal(records.length, 3);
  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 3);
  assert.equal(result.duplicateCount, 0);
  assert.equal(await store.countRecords('Exposure'), 3);
  assert(exposures.every((record) => record.type === 'reference'));
  assert(exposures.every((record) => record.provenance.surface === X_BOOKMARKS_SURFACE));
  assert(exposures.every((record) => record.provenance.lane === 'deliberate'));
  assert(exposures.every((record) => record.frontierExcluded === true));
  assert(exposures.every((record) => record.statement.length <= X_BOOKMARK_STATEMENT_MAX_CHARS));
  assert(longExposure.statement.endsWith('...'));
  assert.equal(longExposure.context, 'bob - https://x.com/bob/status/222');
  assert.equal(longExposure.eventAt, '2026-06-10T20:19:24.000Z');
  assert(exposures.some((record) => record.context === 'alice - https://x.com/alice/status/111'));
  assert(exposures.some((record) => record.context === 'carol - https://x.com/carol/status/333'));

  const context = await gatherContext('decide', { store, dataDir: store.dataDir, limit: 10 });
  assert.doesNotMatch(context, /X_BOOKMARK_PRIVATE_SECRET/);
  assert.match(context, /^Exposure: 0$/m);
});

test('X bookmarks parser accepts JSON assignment exports', () => {
  const payload = [{ tweet: { id: 'assign-1', text: 'Assignment export tweet', author: 'alice' } }];
  const parsed = parseXBookmarksJson(`window.YTD.bookmark.part0 = ${JSON.stringify(payload)};`);

  assert.deepEqual(parsed, payload);
});

test('missing X bookmarks file returns an actionable skipped result', async (t) => {
  const store = await freshStore();
  const file = path.join(await tempDir(t, 'cs-k-x-missing-'), 'absent.json');

  const result = await ingestXBookmarks({ store, file });

  assert.equal(result.skipped, true);
  assert.match(result.message, /ingest-bookmarks-x: no X bookmarks export found/);
  assert.equal(result.createdCount, 0);
  assert.deepEqual(result.exposures, []);
});

test('X bookmarks dedupe is stable on re-run with the same store', async (t) => {
  const store = await freshStore();
  const file = await writeJsonFile(t, {
    bookmarks: [
      {
        tweet: {
          id: 'stable-1',
          text: 'Stable X bookmark text.',
          author: 'founder',
          url: 'https://x.com/founder/status/stable-1',
        },
      },
    ],
  });

  const first = await ingestXBookmarks({ store, file });
  const second = await ingestXBookmarks({ store, file });

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
  assert.equal(second.exposures[0].id, first.exposures[0].id);
});

function xBookmarksFixture() {
  return {
    bookmarks: [
      {
        tweet: {
          id: '111',
          text: 'X_BOOKMARK_PRIVATE_SECRET direct tweet shape.',
          author: { username: 'alice' },
          url: 'https://x.com/alice/status/111',
          createdAt: '2026-06-09T19:00:00.000Z',
        },
      },
      {
        content: {
          itemContent: {
            tweet_results: {
              result: {
                rest_id: '222',
                legacy: {
                  full_text: `X_BOOKMARK_PRIVATE_SECRET nested ${'long text '.repeat(80)}`,
                  created_at: 'Wed Jun 10 20:19:24 +0000 2026',
                },
                core: {
                  user_results: {
                    result: {
                      legacy: {
                        screen_name: 'bob',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        id_str: '333',
        full_text: 'X_BOOKMARK_PRIVATE_SECRET legacy direct shape.',
        user: {
          screen_name: 'carol',
        },
      },
    ],
  };
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-x-bookmarks-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function writeJsonFile(t, payload) {
  const dir = await tempDir(t, 'cs-k-x-bookmarks-');
  const file = path.join(dir, 'x_bookmarks_export.json');
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
