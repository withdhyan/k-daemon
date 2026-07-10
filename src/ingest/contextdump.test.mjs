import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  CONTEXTDUMP_SURFACE,
  contextdumpExposureRecords,
  ingestContextdump,
} from './contextdump.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');

test('contextdump records create one reference Exposure per shallow markdown file', async (t) => {
  const dir = await tempDir(t, 'cs-k-contextdump-');
  const alpha = await writeFileWithMtime(
    path.join(dir, 'alpha.md'),
    'Alpha founder lead.\n\nMore detail.',
    '2026-06-20T10:00:00.000Z',
  );
  const beta = await writeFileWithMtime(
    path.join(dir, 'beta.md'),
    '---\ntitle: ignored frontmatter\n---\n# Beta synthesis lead\nBody.',
    '2026-06-21T11:00:00.000Z',
  );
  const gamma = await writeFileWithMtime(
    path.join(dir, 'nested', 'gamma.md'),
    '> Gamma nested lead\n\nBody.',
    '2026-06-22T12:00:00.000Z',
  );
  await fs.writeFile(path.join(dir, 'binary.md'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(dir, 'empty.md'), '   \n', 'utf8');
  await fs.writeFile(path.join(dir, 'ignored.txt'), 'Ignored text note.', 'utf8');
  await writeFileWithMtime(
    path.join(dir, 'nested', 'deeper', 'ignored.md'),
    'Too deep.',
    '2026-06-23T13:00:00.000Z',
  );

  const records = await contextdumpExposureRecords({ dir });

  const expectedRecords = await Promise.all([
    expectedContextdumpRecord({
      file: alpha,
      root: dir,
      statement: 'Alpha founder lead.',
      eventAt: '2026-06-20T10:00:00.000Z',
    }),
    expectedContextdumpRecord({
      file: beta,
      root: dir,
      statement: 'Beta synthesis lead',
      eventAt: '2026-06-21T11:00:00.000Z',
    }),
    expectedContextdumpRecord({
      file: gamma,
      root: dir,
      statement: 'Gamma nested lead',
      eventAt: '2026-06-22T12:00:00.000Z',
    }),
  ]);

  assert.deepEqual(records, expectedRecords);
});

test('missing contextdump directory returns a skipped result', async (t) => {
  const dir = path.join(await tempDir(t, 'cs-k-contextdump-missing-'), 'absent');
  const store = await freshStore();

  const result = await ingestContextdump({ store, dir });

  assert.equal(result.skipped, true);
  assert.match(result.message, /ingest-contextdump: no context dump found/);
  assert.equal(result.createdCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.exposures, []);
});

test('contextdump ingest dedupes on re-run with the same store', async (t) => {
  const dir = await tempDir(t, 'cs-k-contextdump-dedupe-');
  const store = await freshStore();
  await writeFileWithMtime(
    path.join(dir, 'stable.md'),
    'Stable contextdump lead.\nBody.',
    '2026-06-24T14:00:00.000Z',
  );

  const first = await ingestContextdump({ store, dir });
  const second = await ingestContextdump({ store, dir });

  assert.equal(first.skipped, false);
  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
  assert.equal(second.exposures[0].id, first.exposures[0].id);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-contextdump-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeFileWithMtime(file, content, mtime) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  const date = new Date(mtime);
  await fs.utimes(file, date, date);
  return file;
}

async function expectedContextdumpRecord({ file, root, statement, eventAt }) {
  const buffer = await fs.readFile(file);
  const relativePath = path.relative(root, file).split(path.sep).join('/');
  const contentHash = contentSha256(buffer);

  return {
    type: 'reference',
    statement,
    sourceId: [
      CONTEXTDUMP_SURFACE,
      relativePath,
      contentHash,
    ].join(':'),
    eventAt,
    context: path.basename(file),
    provenance: { surface: CONTEXTDUMP_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      path: relativePath,
      contentHash,
      byteLength: buffer.length,
    },
  };
}

function contentSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
