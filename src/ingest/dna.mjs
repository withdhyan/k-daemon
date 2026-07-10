import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOT,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { walkIngestDir } from './wire.mjs';

const DNA_DATA_DIR = path.join(ROOT, 'data');
const DNA_EXPORT_EXTENSIONS = Object.freeze(['.txt', '.tsv']);
const CALLED_GENOTYPE_PATTERN = /^[ACGTID]{1,2}$/;

export const DNA_INGEST_DIR = fileURLToPath(
  new URL('../../data/ingest/', import.meta.url),
);
export const DNA_SNP_ALLOWLIST_FILE = fileURLToPath(
  new URL('./dna-snp-allowlist.json', import.meta.url),
);
export const DNA_NO_EXPORT_MESSAGE =
  'dna: no export found — drop your DNA export in data/ingest/ and re-run';

export async function ingestDna(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const dataDir = path.resolve(options.dataDir ?? DNA_DATA_DIR);
  const ingestDir = path.resolve(options.ingestDir ?? path.join(dataDir, 'ingest'));

  if (options.text !== undefined) {
    const allowlist = options.allowlist ?? await loadDnaSnpAllowlist(options.allowlistFile);
    return ingestDnaText(options.text, { ...options, store, allowlist });
  }

  const file = await dnaExportPath(options.file ?? options.path, { dataDir, ingestDir });
  if (!file) return skippedResult(store);

  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return skippedResult(store);
    throw error;
  }

  const allowlist = options.allowlist ?? await loadDnaSnpAllowlist(options.allowlistFile);
  return ingestDnaText(text, { ...options, store, allowlist, file });
}

export async function ingestDnaText(text, options = {}) {
  // Direct tests call ingestDnaText; ingestDna has already resolved the production store.
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const allowlist = normalizeAllowlist(options.allowlist ?? await loadDnaSnpAllowlist(options.allowlistFile));
  const parsed = dnaGenomicTraitInputs(text, { allowlist });
  const records = [];
  let createdCount = 0;
  let duplicateCount = 0;

  for (const input of parsed.inputs) {
    const { record, created } = await store.writeGenomicTrait(input, { withWriteResult: true });
    records.push(record);
    if (created) {
      createdCount += 1;
    } else {
      duplicateCount += 1;
    }
  }

  return {
    store,
    file: options.file,
    skipped: false,
    records,
    createdCount,
    duplicateCount,
    parsedCount: parsed.inputs.length,
    storedCount: records.length,
    ...parsed.stats,
  };
}

export function dnaGenomicTraitInputs(text, options = {}) {
  const allowlist = normalizeAllowlist(options.allowlist ?? {});
  const stats = emptyStats();
  const inputs = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    stats.totalLines += 1;
    const row = stripByteOrderMark(line);
    const trimmed = row.trim();
    if (!trimmed) {
      stats.blankLineCount += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      stats.commentLineCount += 1;
      continue;
    }

    const fields = row.split('\t').map((field) => field.trim());
    if (fields.length < 4) {
      stats.malformedLineCount += 1;
      continue;
    }

    const rsid = normalizeRsid(fields[0]);
    if (isHeaderLine(rsid, fields)) {
      stats.headerLineCount += 1;
      continue;
    }

    const chromosome = optionalString(fields[1]);
    const position = optionalString(fields[2]);
    const genotype = normalizeGenotype(fields);
    if (!rsid || !chromosome || !position) {
      stats.malformedLineCount += 1;
      continue;
    }

    const genotypeStatus = calledGenotypeStatus(genotype);
    if (genotypeStatus === 'no-call') {
      stats.noCallLineCount += 1;
      continue;
    }
    if (genotypeStatus === 'malformed') {
      stats.malformedLineCount += 1;
      continue;
    }

    const annotation = allowlist[rsid];
    if (!annotation) {
      stats.nonAllowlistedLineCount += 1;
      continue;
    }

    inputs.push({
      rsid,
      chromosome,
      position,
      genotype,
      trait: annotation.trait,
      category: annotation.category,
      provenance: {
        surface: 'genome',
        lane: 'deliberate',
        via: 'dna-export',
      },
    });
    stats.allowlistedLineCount += 1;
  }

  return { inputs, stats };
}

export async function loadDnaSnpAllowlist(file = DNA_SNP_ALLOWLIST_FILE) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`DNA SNP allowlist not found: ${file}`);
    }
    throw error;
  }

  try {
    return normalizeAllowlist(JSON.parse(text));
  } catch (error) {
    throw new Error(`DNA SNP allowlist must be valid JSON with object annotations: ${file}: ${error.message}`);
  }
}

async function dnaExportPath(explicitPath, { dataDir = DNA_DATA_DIR, ingestDir = DNA_INGEST_DIR } = {}) {
  const normalized = optionalString(explicitPath);
  if (normalized) return safeDnaPath(normalized, dataDir, { allowAbsolute: false });

  const discovered = await discoverDnaExport(ingestDir);
  return discovered ? safeDnaPath(discovered, dataDir, { allowAbsolute: true }) : undefined;
}

async function discoverDnaExport(ingestDir = DNA_INGEST_DIR) {
  const files = await walkIngestDir(
    ingestDir,
    (file) => DNA_EXPORT_EXTENSIONS.includes(path.extname(file).toLowerCase()),
  );
  const sorted = files.sort((a, b) =>
    dnaFileScore(b, ingestDir) - dnaFileScore(a, ingestDir) || a.localeCompare(b));
  return sorted[0];
}

function safeDnaPath(file, dataDir = DNA_DATA_DIR, { allowAbsolute = false } = {}) {
  const normalized = requiredString(file, 'DNA export path');
  if (!allowAbsolute && (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized))) {
    throw new Error(`refused unsafe data path: ${file}`);
  }

  const resolved = path.resolve(normalized);
  return safeDataPath(dataDir, path.relative(dataDir, resolved) || '.');
}

function dnaFileScore(file, ingestDir = DNA_INGEST_DIR) {
  const lower = path.relative(ingestDir, file).toLowerCase();
  return [
    '23andme',
    'ancestry',
    'nebula',
    'genome',
    'genotype',
    'dna',
    'raw_data',
  ].reduce((score, hint) => score + (lower.includes(hint) ? 1 : 0), 0);
}

export function normalizeAllowlist(allowlist) {
  if (!isPlainObject(allowlist)) {
    throw new Error('DNA SNP allowlist must be an object');
  }

  const normalized = {};
  for (const [rawRsid, rawAnnotation] of Object.entries(allowlist)) {
    const rsid = requiredString(normalizeRsid(rawRsid), 'allowlist rsid');
    if (!isPlainObject(rawAnnotation)) {
      throw new Error(`allowlist ${rsid} must be an object`);
    }

    normalized[rsid] = {
      trait: requiredString(rawAnnotation.trait, `allowlist ${rsid}.trait`),
      category: requiredString(rawAnnotation.category, `allowlist ${rsid}.category`),
    };
  }
  return normalized;
}

function normalizeRsid(value) {
  const text = optionalString(value);
  return text ? text.toLowerCase() : undefined;
}

function normalizeGenotype(fields) {
  const alleleFields = fields.length >= 5 ? [fields[3], fields[4]] : [fields[3]];
  if (alleleFields.some((field) => optionalString(field) === undefined)) return undefined;

  const text = optionalString(alleleFields.join(''));
  return text ? text.toUpperCase() : undefined;
}

function isHeaderLine(rsid, fields) {
  return rsid === 'rsid' ||
    (
      rsid === 'snp' &&
      String(fields[1] ?? '').trim().toLowerCase() === 'chromosome'
    );
}

function calledGenotypeStatus(genotype) {
  if (!genotype || genotype.includes('-') || genotype.includes('0')) return 'no-call';
  return CALLED_GENOTYPE_PATTERN.test(genotype) ? 'called' : 'malformed';
}

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

function emptyStats() {
  return {
    totalLines: 0,
    blankLineCount: 0,
    commentLineCount: 0,
    headerLineCount: 0,
    malformedLineCount: 0,
    noCallLineCount: 0,
    nonAllowlistedLineCount: 0,
    allowlistedLineCount: 0,
  };
}

function skippedResult(store) {
  return {
    store,
    file: undefined,
    skipped: true,
    message: DNA_NO_EXPORT_MESSAGE,
    records: [],
    createdCount: 0,
    duplicateCount: 0,
    parsedCount: 0,
    storedCount: 0,
    ...emptyStats(),
  };
}
