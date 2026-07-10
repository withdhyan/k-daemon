import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  bookmarkExposureRecords,
  ingestBookmarks,
  loadBookmarks,
} from './bookmarks.mjs';
import { ingestWire } from './wire.mjs';

const BOOKMARKS_FIXTURE = Object.freeze({
  source: 'test-bookmarks',
  ingested_at: '2026-06-26T12:00:00.000Z',
  count: 3,
  items: [
    {
      name: 'Attention recovery reference',
      url: 'https://example.test/attention',
      folder: 'Bookmarks Bar/K/2.0',
      added: '13395009600000000',
    },
    {
      name: 'Local loop reference',
      url: 'https://example.test/loop',
      folder: 'Bookmarks Bar/K',
      added: '13395013200000000',
    },
    {
      name: 'Research reference',
      url: 'https://example.test/research',
      folder: 'Other Bookmarks/Research',
      added: '13395016800000000',
    },
  ],
});

const fixedNow = () => new Date('2026-06-27T00:00:00.000Z');

test('ingests a bookmarks file as one Exposure per bookmark', async (t) => {
  const store = await freshStore();
  const file = await writeBookmarksFixture(t);
  const payload = await loadBookmarks(file);
  const records = bookmarkExposureRecords(payload);

  const result = await ingestBookmarks({ store, file });

  assert.equal(payload.items.length, payload.count);
  assert.equal(records.length, payload.count);
  assert.equal(result.createdCount, payload.count);
  assert.equal(result.exposures.length, payload.count);
  assert.equal(await store.countRecords('Exposure'), payload.count);
  assert(result.exposures.every((record) => record.kind === 'Exposure'));
  assert(result.exposures.every((record) => record.type === 'reference'));
  assert(result.exposures.every((record) => record.provenance.surface === 'chrome'));
  assert(result.exposures.every((record) => record.provenance.lane === 'deliberate'));
});

test('re-running bookmark ingest produces zero duplicates', async (t) => {
  const store = await freshStore();
  const file = await writeBookmarksFixture(t);
  const payload = await loadBookmarks(file);

  await ingestBookmarks({ store, file });
  const second = await ingestBookmarks({ store, file });

  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, payload.count);
  assert.equal(await store.countRecords('Exposure'), payload.count);
});

test('re-running bookmark ingest leaves substrate files untouched', async (t) => {
  const store = await freshStore();
  const file = await writeBookmarksFixture(t);

  await ingestBookmarks({ store, file });
  const before = await substrateSnapshot(store.dataDir);

  await ingestBookmarks({ store, file });
  const after = await substrateSnapshot(store.dataDir);

  assert.deepEqual(after, before);
});

test('bookmark folder context is preserved on the Exposure record', async (t) => {
  const store = await freshStore();
  const file = await writeBookmarksFixture(t);
  const payload = await loadBookmarks(file);
  const index = payload.items.findIndex((bookmark) => bookmark.folder?.includes('/2.0'));

  const result = await ingestBookmarks({ store, file });
  const exposure = result.exposures[index];

  assert(index >= 0);
  assert.equal(exposure.context, payload.items[index].folder);
  assert.match(exposure.statement, new RegExp(escapeRegExp(payload.items[index].name)));
  assert.match(exposure.statement, new RegExp(escapeRegExp(payload.items[index].url)));
});

test('malformed bookmark added timestamp does not abort ingest', async () => {
  const store = await freshStore();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-bookmarks-data-'));
  const file = path.join(dataDir, 'bookmarks.json');
  await fs.writeFile(
    file,
    `${JSON.stringify({
      source: 'test-bookmarks',
      ingested_at: '2026-06-27T00:00:00.000Z',
      items: [
        {
          name: 'Bad timestamp still ingests',
          url: 'https://example.com/bad-added',
          folder: 'test',
          added: 'not-a-number',
        },
      ],
    })}\n`,
    'utf8',
  );

  const payload = await loadBookmarks(file);
  const records = bookmarkExposureRecords(payload);
  const result = await ingestBookmarks({ store, file });

  assert.equal(records[0].eventAt, undefined);
  assert.equal(result.createdCount, 1);
  assert.equal(result.exposures.length, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
});

test('the generic wire accepts an arbitrary surface', async () => {
  const store = await freshStore();

  const result = await ingestWire(
    [
      {
        type: 'reference',
        statement: 'A made-up source can still enter the substrate.',
        sourceId: 'made-up:1',
        context: 'test fixture',
        provenance: { lane: 'ambient' },
      },
    ],
    'made-up-surface',
    { store },
  );

  assert.equal(result.createdCount, 1);
  assert.equal(result.exposures[0].provenance.surface, 'made-up-surface');
  assert.equal(result.exposures[0].provenance.lane, 'ambient');
  assert.equal(await store.countRecords('Exposure'), 1);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-ingest-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function writeBookmarksFixture(t, payload = BOOKMARKS_FIXTURE) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-bookmarks-fixture-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const file = path.join(dataDir, 'bookmarks.json');
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function substrateSnapshot(dataDir) {
  const root = path.join(dataDir, 'substrate');
  const files = [];
  await walk(root, root, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root, dir, files) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, entryPath, files);
    } else if (entry.isFile()) {
      const content = await fs.readFile(entryPath);
      const stat = await fs.stat(entryPath);
      files.push({
        path: path.relative(root, entryPath),
        mtimeMs: stat.mtimeMs,
        hash: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
}
