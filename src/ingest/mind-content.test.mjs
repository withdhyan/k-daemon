import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  MIND_CONTENT_CHUNK_MAX_CHARS,
  MIND_CONTENT_SURFACE,
  blockedMindContentPath,
  chunkMindContent,
  ingestMindContent,
  mindContentExposureRecords,
} from './mind-content.mjs';

const fixedNow = () => new Date('2026-07-06T00:00:00.000Z');

test('mind-content ingest writes only approved canonical docs with R4.3 consent', async (t) => {
  const root = await tempDir(t, 'cs-k-mind-content-');
  const sourceRoot = path.join(root, 'ai', 'k', 'docs', 'bio', 'transcendence-stack');
  const kedarProduct = path.join(root, 'ai', 'kedar', 'docs', 'product');
  const postSapiens = path.join(root, 'ai', 'obsidian-vault', '03 - Post-Sapiens');
  const awakening = path.join(root, 'ai', 'obsidian-vault', '06 - Transcendence');
  const store = await freshStore();

  await writeFileWithMtime(
    path.join(sourceRoot, '00-INTEGRATED-STRATEGY.md'),
    '# Approved transcendence stack\n\nFull doctrine body, not only the title.',
    '2026-06-12T08:00:00.000Z',
  );
  await writeFileWithMtime(
    path.join(sourceRoot, 'india-transcendence-synthesis.md'),
    '# Excluded India synthesis\n\nMust stay out.',
    '2026-06-12T08:01:00.000Z',
  );
  await writeFileWithMtime(
    path.join(sourceRoot, 'iq-scaling-evidence-dossier.md'),
    '# Excluded dossier\n\nMust stay out.',
    '2026-06-12T08:02:00.000Z',
  );
  await writeFileWithMtime(
    path.join(sourceRoot, 'pitch deck.md'),
    '# Excluded deck\n\nMust stay out.',
    '2026-06-12T08:03:00.000Z',
  );
  await writeFileWithMtime(
    path.join(kedarProduct, 'ascend-path-spec-packet.md'),
    '---\ntitle: ignored\n---\n# Approved ascend path\n\nLane-scoped trust.',
    '2026-06-13T09:00:00.000Z',
  );
  await writeFileWithMtime(
    path.join(postSapiens, 'post-sapiens.md'),
    '# Approved post-sapiens\n\nPost-sapiens corpus body.',
    '2026-06-14T10:00:00.000Z',
  );
  await writeFileWithMtime(
    path.join(postSapiens, 'Indic-experiment.md'),
    '# Excluded Indic branch\n\nMust stay out.',
    '2026-06-14T10:01:00.000Z',
  );
  await writeFileWithMtime(
    path.join(awakening, 'enlightenment.md'),
    '# Approved awakening\n\nAwakening corpus body.',
    '2026-06-15T11:00:00.000Z',
  );

  const result = await ingestMindContent({
    store,
    sources: fixtureSources({ sourceRoot, kedarProduct, postSapiens, awakening }),
  });
  const exposures = result.exposures.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));

  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 4);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.excludedCount, 4);
  assert.equal(await store.countRecords('Exposure'), 4);
  assert(exposures.every((record) => record.provenance.surface === MIND_CONTENT_SURFACE));
  assert(exposures.every((record) => record.type === 'reference'));
  assert(exposures.every((record) => record.frontierExcluded === true));
  assert(exposures.every((record) => record.metadata.canonicalMindContent === true));
  assert(exposures.every((record) => record.metadata.consent.state === 'approved'));
  assert(exposures.every((record) => record.metadata.consent.verdict === 'R4.3'));
  assert(exposures.every((record) => record.metadata.consent.excludedCorpus.includes('iq-dossier')));
  assert(exposures.every((record) => record.metadata.human === true));
  assert(exposures.every((record) => record.metadata.role === 'user'));
  assert(exposures.every((record) => record.metadata.conversationId.startsWith(`${MIND_CONTENT_SURFACE}:`)));
  assert(exposures.some((record) => record.statement.includes('Full doctrine body, not only the title.')));
  assert.deepEqual(
    exposures.map((record) => record.metadata.path),
    [
      '00-INTEGRATED-STRATEGY.md',
      'ascend-path-spec-packet.md',
      'enlightenment.md',
      'post-sapiens.md',
    ],
  );

  const serialized = JSON.stringify(exposures);
  assert(!serialized.includes('Excluded India synthesis'));
  assert(!serialized.includes('Excluded dossier'));
  assert(!serialized.includes('Excluded deck'));
  assert(!serialized.includes('Excluded Indic branch'));
});

test('mind-content ingest is dedupe-idempotent on rerun', async (t) => {
  const root = await tempDir(t, 'cs-k-mind-content-dedupe-');
  const sourceRoot = path.join(root, 'approved');
  const store = await freshStore();
  await writeFileWithMtime(
    path.join(sourceRoot, 'strategy.md'),
    '# Stable canonical doc\n\nStable body.',
    '2026-06-16T12:00:00.000Z',
  );

  const sources = [
    {
      key: 'fixture-transcendence',
      label: 'Fixture transcendence',
      corpus: 'transcendence-stack',
      root: sourceRoot,
    },
  ];
  const first = await ingestMindContent({ store, sources });
  const second = await ingestMindContent({ store, sources });

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 1);
  assert.equal(await store.countRecords('Exposure'), 1);
  assert.equal(second.exposures[0].id, first.exposures[0].id);
});

test('mind-content missing corpus sources fail soft and write nothing', async (t) => {
  const root = await tempDir(t, 'cs-k-mind-content-missing-');
  const store = await freshStore();

  const result = await ingestMindContent({
    store,
    sources: [
      {
        key: 'missing-post-sapiens',
        label: 'Missing post-sapiens',
        corpus: 'post-sapiens',
        root: path.join(root, 'absent'),
      },
    ],
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-approved-corpus-sources');
  assert.match(result.message, /ingest-mind-content: no approved mind-content corpus sources found/);
  assert.equal(result.createdCount, 0);
  assert.equal(result.missingSources.length, 1);
  assert.equal(await store.countRecords('Exposure'), 0);
});

test('mind-content chunks long docs into extraction-sized founder-authored records', async (t) => {
  const root = await tempDir(t, 'cs-k-mind-content-chunk-');
  const sourceRoot = path.join(root, 'approved');
  const longBody = `# Long awakening doc\n\n${'chunk body '.repeat(1400)}`;
  await writeFileWithMtime(
    path.join(sourceRoot, 'long.md'),
    longBody,
    '2026-06-17T13:00:00.000Z',
  );

  const { records } = await mindContentExposureRecords({
    sources: [
      {
        key: 'fixture-awakening',
        label: 'Fixture awakening',
        corpus: 'awakening',
        root: sourceRoot,
      },
    ],
  });

  assert.equal(chunkMindContent(longBody, MIND_CONTENT_CHUNK_MAX_CHARS).length, 2);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.metadata.chunkNumber), [1, 2]);
  assert(records.every((record) => record.metadata.chunkCount === 2));
  assert(records.every((record) => record.statement.length <= MIND_CONTENT_CHUNK_MAX_CHARS));
  assert.notEqual(records[0].metadata.conversationId, records[1].metadata.conversationId);
});

test('mind-content blocked path predicate captures R4.3 excluded files', () => {
  assert.equal(blockedMindContentPath('india-transcendence-synthesis.md'), true);
  assert.equal(blockedMindContentPath('iq-scaling-evidence-dossier.md'), true);
  assert.equal(blockedMindContentPath('pitch deck.md'), true);
  assert.equal(blockedMindContentPath('Indic-experiment.md'), true);
  assert.equal(blockedMindContentPath('post-sapiens.md'), false);
  assert.equal(blockedMindContentPath('docs/bio/transcendence-stack/00-INTEGRATED-STRATEGY.md'), false);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-content-data-'));
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

function fixtureSources({ sourceRoot, kedarProduct, postSapiens, awakening }) {
  return [
    {
      key: 'fixture-transcendence',
      label: 'Fixture transcendence',
      corpus: 'transcendence-stack',
      root: sourceRoot,
    },
    {
      key: 'fixture-ascend',
      label: 'Fixture ascend',
      corpus: 'ascend-path',
      file: path.join(kedarProduct, 'ascend-path-spec-packet.md'),
    },
    {
      key: 'fixture-post-sapiens',
      label: 'Fixture post-sapiens',
      corpus: 'post-sapiens',
      root: postSapiens,
    },
    {
      key: 'fixture-awakening',
      label: 'Fixture awakening',
      corpus: 'awakening',
      root: awakening,
    },
  ];
}
