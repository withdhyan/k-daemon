import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  X_BOOKMARKS_SURFACE,
  ingestXBookmarksLive,
  xBookmarkToExposure,
} from './x-bookmarks-live.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');

test('live X bookmark harvest entries normalize to reference Exposures', () => {
  const entry = {
    id: '123',
    text: 'Founder live bookmark.\nSecond line.',
    authorHandle: 'founder',
    url: 'https://x.com/founder/status/123',
    createdAt: '2026-06-10T20:19:24.000Z',
  };
  const text = 'Founder live bookmark. Second line.';
  const contentHash = contentSha256(text);

  assert.deepEqual(xBookmarkToExposure(entry), {
    type: 'reference',
    statement: text,
    sourceId: [
      X_BOOKMARKS_SURFACE,
      entry.id,
      contentHash,
    ].join(':'),
    eventAt: '2026-06-10T20:19:24.000Z',
    context: 'founder',
    provenance: { surface: X_BOOKMARKS_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      url: 'https://x.com/founder/status/123',
      authorHandle: 'founder',
    },
  });

  const invalidDate = xBookmarkToExposure({
    id: 'invalid-date',
    text: 'Valid text with invalid date.',
    createdAt: 'not-a-date',
  });
  assert.equal(Object.hasOwn(invalidDate, 'eventAt'), false);
});

test('live X bookmarks drop entries with no usable text', async () => {
  const store = await freshStore();
  const result = await ingestXBookmarksLive([
    { id: 'missing-text', authorHandle: 'founder' },
    {
      id: 'has-text',
      text: 'Usable bookmark text.',
      authorHandle: 'founder',
      url: 'https://x.com/founder/status/has-text',
    },
  ], { store });

  assert.equal(xBookmarkToExposure({ id: 'missing-text' }), undefined);
  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 1);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.exposures.length, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
});

test('empty or non-array live X bookmark input soft-skips', async () => {
  const store = await freshStore();

  const empty = await ingestXBookmarksLive([], { store });
  const nonArray = await ingestXBookmarksLive(null, { store });

  assert.equal(empty.skipped, true);
  assert.equal(empty.createdCount, 0);
  assert.deepEqual(empty.exposures, []);
  assert.equal(nonArray.skipped, true);
  assert.equal(nonArray.createdCount, 0);
});

test('live X bookmarks dedupe on re-ingest with the same store', async () => {
  const store = await freshStore();
  const entries = [
    {
      id: 'stable-1',
      text: 'Stable live bookmark text.',
      authorHandle: 'founder',
      url: 'https://x.com/founder/status/stable-1',
      createdAt: '2026-06-11T21:00:00.000Z',
    },
  ];

  const first = await ingestXBookmarksLive(entries, { store });
  const second = await ingestXBookmarksLive(entries, { store });

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
  assert.equal(second.exposures[0].id, first.exposures[0].id);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-x-bookmarks-live-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

function contentSha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}
