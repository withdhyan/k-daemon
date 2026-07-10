import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gatherContext } from '../../daemon/run.mjs';
import { embedRecord } from '../research/embed.mjs';
import { research } from '../research/pipeline.mjs';
import {
  RECORD_KINDS,
  createSubstrateStore,
  genomicTraitDedupeKey,
} from '../substrate.mjs';
import {
  dnaGenomicTraitInputs,
  ingestDna,
  loadDnaSnpAllowlist,
  normalizeAllowlist,
} from './dna.mjs';

const fixedNow = () => new Date('2026-06-27T00:00:00.000Z');
const DNA_FIXTURE = [
  '# 23andMe raw data fixture',
  'rsid\tchromosome\tposition\tgenotype',
  'rs4988235\t2\t136608646\tAG',
  'rs1801133\t1\t11856378\tCT',
  'rs762551\t15\t75041917\tAA',
  'rs9999999\t1\t12345\tGG',
  'rs4680\t22\t19963748\t--',
  'malformed-short-line',
  'rs1801260\t4\t56308526\t00',
  'rs73598374\t20\t43211234\tII',
  'rs1799883\t4\t120241362\tDD',
].join('\n');

test('23andMe-format fixture stores only allowlisted valid called GenomicTrait records', async () => {
  const store = await freshStore();
  const allowlist = await loadDnaSnpAllowlist();

  const result = await ingestDna({ store, text: DNA_FIXTURE, allowlist });
  const records = await store.listRecords('GenomicTrait');
  const lct = records.find((record) => record.rsid === 'rs4988235');
  const mthfr = records.find((record) => record.rsid === 'rs1801133');

  assert.equal(result.createdCount, 5);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.nonAllowlistedLineCount, 1);
  assert.equal(result.malformedLineCount, 1);
  assert.equal(result.noCallLineCount, 2);
  assert.equal(records.length, 5);
  assert(records.every((record) => record.kind === 'GenomicTrait'));
  assert(records.every((record) => record.provenance.surface === 'genome'));
  assert(records.every((record) => record.provenance.lane === 'deliberate'));
  assert.equal(lct.rsid, 'rs4988235');
  assert.equal(lct.genotype, 'AG');
  assert.equal(lct.trait, allowlist.rs4988235.trait);
  assert.equal(lct.category, allowlist.rs4988235.category);
  assert.equal(lct.chromosome, '2');
  assert.equal(lct.position, '136608646');
  assert.equal(lct.provenance.surface, 'genome');
  assert.equal(mthfr.genotype, 'CT');
  assert.equal(mthfr.trait, allowlist.rs1801133.trait);
});

test('non-allowlisted rsids are not stored', async () => {
  const store = await freshStore();

  await ingestDna({ store, text: DNA_FIXTURE, allowlist: await loadDnaSnpAllowlist() });
  const rsids = (await store.listRecords('GenomicTrait')).map((record) => record.rsid);

  assert(!rsids.includes('rs9999999'));
});

test('malformed and no-call DNA lines are skipped without aborting the batch', async () => {
  const allowlist = await loadDnaSnpAllowlist();
  const parsed = dnaGenomicTraitInputs(DNA_FIXTURE, { allowlist });
  const rsids = parsed.inputs.map((input) => input.rsid);

  assert.equal(parsed.stats.malformedLineCount, 1);
  assert.equal(parsed.stats.noCallLineCount, 2);
  assert(!rsids.includes('rs4680'));
  assert(!rsids.includes('rs1801260'));
  assert(rsids.includes('rs4988235'));
});

test('invalid genotypes are counted as no-call or malformed and are not stored', async () => {
  const store = await freshStore();
  const allowlist = await loadDnaSnpAllowlist();
  const text = [
    'rsid\tchromosome\tposition\tgenotype',
    'rs4988235\t2\t136608646\tAGG',
    'rs1801133\t1\t11856378\tA-',
    'rs762551\t15\t75041917\t漢字',
    `rs73598374\t20\t43211234\t${'A'.repeat(100000)}`,
    'rs1799883\t4\t120241362\tN',
    'rs4680\t22\t19963748\tA\t',
  ].join('\n');

  const result = await ingestDna({ store, text, allowlist });

  assert.equal(result.createdCount, 0);
  assert.equal(result.noCallLineCount, 2);
  assert.equal(result.malformedLineCount, 4);
  assert.deepEqual(await store.listRecords('GenomicTrait'), []);
});

test('Ancestry two-allele columns are joined and per-allele no-calls are skipped', async () => {
  const store = await freshStore();
  const allowlist = await loadDnaSnpAllowlist();
  const text = [
    'rsid\tchromosome\tposition\tallele1\tallele2',
    'rs4988235\t2\t136608646\tA\tG',
    'rs4680\t22\t19963748\t0\t0',
    'rs1801260\t4\t56308526\t-\t-',
  ].join('\n');

  const result = await ingestDna({ store, text, allowlist });
  const records = await store.listRecords('GenomicTrait');

  assert.equal(result.createdCount, 1);
  assert.equal(result.noCallLineCount, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].rsid, 'rs4988235');
  assert.equal(records[0].genotype, 'AG');
});

test('indel genotypes are valid called GenomicTraits', async () => {
  const store = await freshStore();

  await ingestDna({ store, text: DNA_FIXTURE, allowlist: await loadDnaSnpAllowlist() });
  const records = await store.listRecords('GenomicTrait');

  assert(records.some((record) => record.rsid === 'rs73598374' && record.genotype === 'II'));
  assert(records.some((record) => record.rsid === 'rs1799883' && record.genotype === 'DD'));
});

test('re-ingesting the same DNA fixture is idempotent', async () => {
  const store = await freshStore();
  const allowlist = await loadDnaSnpAllowlist();

  await ingestDna({ store, text: DNA_FIXTURE, allowlist });
  const second = await ingestDna({ store, text: DNA_FIXTURE, allowlist });

  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 5);
  assert.equal(await store.countRecords('GenomicTrait'), 5);
});

test('within-file duplicate rsids are counted once as created and once as duplicate', async () => {
  const store = await freshStore();
  const text = [
    'rsid\tchromosome\tposition\tgenotype',
    'rs4988235\t2\t136608646\tAG',
    'rs4988235\t2\t136608646\tAG',
  ].join('\n');

  const result = await ingestDna({ store, text, allowlist: await loadDnaSnpAllowlist() });
  const records = await store.listRecords('GenomicTrait');

  assert.equal(result.createdCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].genotype, 'AG');
});

test('GenomicTrait lookup returns the expected actionable genotype and category', async () => {
  const store = await freshStore();

  await ingestDna({ store, text: DNA_FIXTURE, allowlist: await loadDnaSnpAllowlist() });
  const records = await store.listRecords('GenomicTrait');
  const caffeine = records.find((record) => record.rsid === 'rs762551');

  assert.equal(caffeine.genotype, 'AA');
  assert.equal(caffeine.trait, 'CYP1A2 caffeine metabolism');
  assert.equal(caffeine.category, 'caffeine');
});

test('corrected GenomicTrait genotype supersedes the prior live rsid record', async () => {
  const store = await freshStore();
  const allowlist = await loadDnaSnpAllowlist();
  const agText = [
    'rsid\tchromosome\tposition\tgenotype',
    'rs4988235\t2\t136608646\tAG',
  ].join('\n');
  const ggText = [
    'rsid\tchromosome\tposition\tgenotype',
    'rs4988235\t2\t136608646\tGG',
  ].join('\n');

  const first = await ingestDna({ store, text: agText, allowlist });
  const second = await ingestDna({ store, text: ggText, allowlist });
  const third = await ingestDna({ store, text: ggText, allowlist });
  const records = await store.listRecords('GenomicTrait');
  const live = records.filter((record) => record.rsid === 'rs4988235' && !record.validTo);
  const retired = records.find((record) => record.rsid === 'rs4988235' && record.validTo);

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 1);
  assert.equal(second.duplicateCount, 0);
  assert.equal(third.createdCount, 0);
  assert.equal(third.duplicateCount, 1);
  assert.equal(live.length, 1);
  assert.equal(live[0].genotype, 'GG');
  assert.equal(retired.genotype, 'AG');
  assert.equal(retired.supersededById, live[0].id);
  assert.equal(
    genomicTraitDedupeKey(first.records[0]),
    genomicTraitDedupeKey(second.records[0]),
  );
});

test('DNA discovery finds the highest-scoring export under a temp ingest dir', async (t) => {
  const store = await freshStore();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dna-discovery-'));
  const ingestDir = path.join(dataDir, 'ingest', 'nested');
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.mkdir(ingestDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'ingest', 'misc.tsv'),
    'rsid\tchromosome\tposition\tgenotype\nrs762551\t15\t75041917\tAA\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(ingestDir, '23andme_raw_data.tsv'),
    'rsid\tchromosome\tposition\tgenotype\nrs4988235\t2\t136608646\tAG\n',
    'utf8',
  );

  const result = await ingestDna({
    store,
    dataDir,
    allowlist: await loadDnaSnpAllowlist(),
  });

  assert.equal(result.createdCount, 1);
  assert.equal(result.records[0].rsid, 'rs4988235');
  assert.match(result.file, /23andme_raw_data\.tsv$/);
});

test('explicit DNA export paths reject parent traversal and absolute paths', async () => {
  const store = await freshStore();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dna-paths-'));
  const absolutePath = path.join(dataDir, 'ingest', '23andme.tsv');

  await assert.rejects(
    ingestDna({ store, dataDir, path: '../escape.tsv' }),
    /refused unsafe data path/,
  );
  await assert.rejects(
    ingestDna({ store, dataDir, path: absolutePath }),
    /refused unsafe data path/,
  );
});

test('missing, corrupt, and non-object allowlists throw clear errors', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dna-allowlist-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const garbageFile = path.join(dataDir, 'garbage.json');
  await fs.writeFile(garbageFile, '{bad json', 'utf8');

  await assert.rejects(
    loadDnaSnpAllowlist(path.join(dataDir, 'missing.json')),
    /DNA SNP allowlist not found/,
  );
  await assert.rejects(
    loadDnaSnpAllowlist(garbageFile),
    /DNA SNP allowlist must be valid JSON/,
  );
  assert.throws(
    () => normalizeAllowlist([]),
    /DNA SNP allowlist must be an object/,
  );
});

test('ingestDna returns a skipped result when no export is present', async (t) => {
  const store = await freshStore();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dna-empty-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const result = await ingestDna({
    store,
    dataDir,
    allowlist: await loadDnaSnpAllowlist(),
  });

  assert.equal(result.skipped, true);
  assert.deepEqual(result.records, []);
  assert.equal(Object.hasOwn(result, 'traits'), false);
});

test('CRLF and UTF-8 BOM DNA exports ingest correctly', async () => {
  const store = await freshStore();
  const text = '\uFEFFrsid\tchromosome\tposition\tgenotype\r\nrs4988235\t2\t136608646\tAG\r\n';

  const result = await ingestDna({ store, text, allowlist: await loadDnaSnpAllowlist() });
  const records = await store.listRecords('GenomicTrait');

  assert.equal(result.createdCount, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].rsid, 'rs4988235');
  assert.equal(records[0].genotype, 'AG');
});

test('KTD9 keeps GenomicTrait out of frontier context and embedding paths', async () => {
  const store = await freshStore();

  const genomic = await store.writeGenomicTrait({
    rsid: 'rs4988235',
    chromosome: '2',
    position: '136608646',
    genotype: 'AG',
    trait: 'LCT lactase persistence',
    category: 'nutrition',
    provenance: { surface: 'genome', lane: 'deliberate' },
  });
  await store.writeExposure({
    type: 'observation',
    statement: 'This ordinary exposure is prompt-safe.',
    sourceId: 'test:prompt-safe',
    eventAt: '2026-06-26T12:00:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });

  const context = await gatherContext('decide', {
    store,
    dataDir: store.dataDir,
    limit: 10,
  });
  const genericRecords = await store.listRecords();
  const researchResults = await research('prompt-safe query', {
    store,
    dataDir: store.dataDir,
    cacheDir: path.join(store.dataDir, 'embeddings'),
    testEmbedder: fakeResearchEmbedder,
    k: 1,
    levy: false,
    argus: false,
    vrsdIntermediate: 1,
  });

  assert(RECORD_KINDS.includes('GenomicTrait'));
  assert.match(context, /^Exposure: 1$/m);
  assert.doesNotMatch(context, /GenomicTrait/);
  assert.doesNotMatch(context, /rs4988235/);
  assert(genericRecords.every((record) => record.kind !== 'GenomicTrait'));
  await assert.rejects(
    embedRecord(genomic, {
      dataDir: store.dataDir,
      cacheDir: path.join(store.dataDir, 'embeddings'),
      embedder: async () => {
        throw new Error('GenomicTrait must not be embedded');
      },
    }),
    /unsupported embeddable record kind: GenomicTrait/,
  );
  assert.equal(researchResults.length, 1);
  assert.deepEqual(researchResults.map((result) => result.kind), ['Exposure']);
  assert.doesNotMatch(researchResults[0].content, /rs4988235|LCT/);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dna-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function fakeResearchEmbedder(prompt) {
  const vectors = new Map([
    ['prompt-safe query', [1, 0]],
    ['This ordinary exposure is prompt-safe.', [1, 0]],
  ]);
  const vector = vectors.get(prompt);
  if (!vector) throw new Error(`unexpected embedding prompt: ${prompt}`);
  return vector;
}
