import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  gatherContext,
  registerSourceEntries,
} from '../../daemon/run.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import {
  NOTE_STATEMENT_MAX_CHARS,
  NOTES_SURFACE,
  ingestNotes,
  noteLeadStatement,
  notesExposureRecordsFromDir,
} from './notes.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');

test('notes ingest creates one sovereign reference Exposure per text or markdown file', async (t) => {
  const dir = await tempDir(t, 'cs-k-notes-export-');
  const store = await freshStore();
  const secret = 'HOLON_NOTE_PRIVATE_SECRET must stay sovereign-only.';
  const txtFile = await writeFileWithMtime(
    path.join(dir, 'alpha.txt'),
    `${secret}\n\nMore detail.`,
    '2026-06-20T10:00:00.000Z',
  );
  await writeFileWithMtime(
    path.join(dir, 'beta.md'),
    '---\ntitle: ignored frontmatter\n---\n# Founder synthesis lead\nBody.',
    '2026-06-21T11:00:00.000Z',
  );
  await fs.writeFile(path.join(dir, 'empty.txt'), '   \n', 'utf8');
  await fs.writeFile(path.join(dir, 'binary.txt'), Buffer.from([0, 1, 2, 3]));

  const records = await notesExposureRecordsFromDir(dir);
  const result = await ingestNotes({ store, dir });
  const exposures = result.exposures.sort((a, b) => a.context.localeCompare(b.context));

  assert.equal(records.length, 2);
  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 2);
  assert.equal(result.duplicateCount, 0);
  assert.equal(await store.countRecords('Exposure'), 2);
  assert(exposures.every((record) => record.type === 'reference'));
  assert(exposures.every((record) => record.provenance.surface === NOTES_SURFACE));
  assert(exposures.every((record) => record.provenance.lane === 'deliberate'));
  assert(exposures.every((record) => record.frontierExcluded === true));
  assert.deepEqual(exposures.map((record) => record.context), ['alpha.txt', 'beta.md']);
  assert.equal(exposures[0].statement, secret);
  assert.equal(exposures[0].eventAt, '2026-06-20T10:00:00.000Z');
  assert.match(exposures[0].sourceId, /^holon-notes:alpha\.txt:[a-f0-9]{64}$/);
  assert.equal(exposures[0].metadata.path, 'alpha.txt');
  assert.equal(exposures[1].statement, 'Founder synthesis lead');
  assert.equal((await fs.stat(txtFile)).mtime.toISOString(), exposures[0].eventAt);

  const context = await gatherContext('decide', { store, dataDir: store.dataDir, limit: 10 });
  assert.doesNotMatch(context, new RegExp(secret));
  assert.match(context, /^Exposure: 0$/m);
});

test('notes lead statements are bounded', () => {
  const longLead = `# ${'founder '.repeat(100)}`;
  const statement = noteLeadStatement(longLead);

  assert(statement.length <= NOTE_STATEMENT_MAX_CHARS);
  assert(statement.endsWith('...'));
});

test('empty notes directory is graceful and writes no Exposures', async (t) => {
  const dir = await tempDir(t, 'cs-k-notes-empty-');
  const store = await freshStore();

  const result = await ingestNotes({ store, dir });

  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 0);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.exposures, []);
  assert.equal(await store.countRecords('Exposure'), 0);
});

test('missing notes directory returns an actionable skipped result', async (t) => {
  const dir = path.join(await tempDir(t, 'cs-k-notes-missing-'), 'absent');
  const store = await freshStore();

  const result = await ingestNotes({ store, dir });

  assert.equal(result.skipped, true);
  assert.match(result.message, /ingest-notes: no notes export found/);
  assert.equal(result.createdCount, 0);
});

test('notes dedupe is stable on re-run with the same store', async (t) => {
  const dir = await tempDir(t, 'cs-k-notes-dedupe-');
  const store = await freshStore();
  await writeFileWithMtime(
    path.join(dir, 'stable.txt'),
    'Stable founder note lead.\nBody.',
    '2026-06-22T12:00:00.000Z',
  );

  const first = await ingestNotes({ store, dir });
  const second = await ingestNotes({ store, dir });

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
  assert.equal(second.exposures[0].id, first.exposures[0].id);
});

test('daemon source registry registration preserves inactive toggles', async (t) => {
  const dataDir = await tempDir(t, 'cs-k-source-registry-');
  await fs.writeFile(
    path.join(dataDir, 'sources.json'),
    `${JSON.stringify({
      kind: 'SourcesRegistry',
      schemaVersion: 1,
      sources: {
        [NOTES_SURFACE]: {
          label: 'Old notes label',
          kind: 'file',
          active: false,
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const registry = await registerSourceEntries({
    dataDir,
    now: fixedNow,
    sources: [
      {
        id: NOTES_SURFACE,
        label: 'Holon notes',
        kind: 'file',
      },
      {
        id: 'x-bookmarks',
        label: 'X bookmarks',
        kind: 'bookmarks',
      },
    ],
  });

  assert.equal(registry.kind, 'SourcesRegistry');
  assert.equal(registry.sources[NOTES_SURFACE].label, 'Holon notes');
  assert.equal(registry.sources[NOTES_SURFACE].active, false);
  assert.equal(registry.sources['x-bookmarks'].active, true);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-notes-data-'));
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
