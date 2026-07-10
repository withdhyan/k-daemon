import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import {
  ingestWire,
  walkIngestDir,
} from './wire.mjs';
import { noteLeadStatement } from './notes.mjs';

export const MIND_CONTENT_SURFACE = 'mind-content';
export const MIND_CONTENT_CHUNK_MAX_CHARS = 12_000;
export const MIND_CONTENT_CONSENT = Object.freeze({
  state: 'approved',
  recordedAt: '2026-07-05',
  verdict: 'R4.3',
  scope: 'canonical-mind-content',
  approvedCorpus: Object.freeze([
    'transcendence-stack',
    'ascend-path',
    'post-sapiens',
    'awakening',
  ]),
  excludedCorpus: Object.freeze([
    'india-synthesis',
    'iq-dossier',
    'pitch-deck',
  ]),
});
export const MIND_CONTENT_NO_SOURCE_MESSAGE =
  'ingest-mind-content: no approved mind-content corpus sources found - expected ai/k, kedar, and obsidian approved corpus paths';

const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.txt']);
const APPROVED_CORPORA = new Set(MIND_CONTENT_CONSENT.approvedCorpus);
const BLOCKED_PATH_PATTERNS = Object.freeze([
  /(?:^|[/\\])india-transcendence(?:[/\\]|[-_.\s]|$)/i,
  /(?:^|[/\\])india-transcendence-synthesis\.md$/i,
  /(?:^|[/\\])india-transcendence-notes-archive\.md$/i,
  /(?:^|[/\\])iq-scaling-evidence-dossier\.md$/i,
  /(?:^|[/\\])pitch(?:[-_\s]?deck)?\.md$/i,
  /(?:^|[/\\])indic-experiment\.md$/i,
]);

export const DEFAULT_MIND_CONTENT_SOURCES = Object.freeze([
  Object.freeze({
    key: 'ai-k-transcendence-stack',
    label: 'ai/k transcendence stack',
    corpus: 'transcendence-stack',
    root: '/Users/mfaz/ai/k/docs/bio/transcendence-stack',
  }),
  Object.freeze({
    key: 'kedar-ascend-path',
    label: 'kedar ascend path',
    corpus: 'ascend-path',
    file: '/Users/mfaz/ai/kedar/docs/product/ascend-path-spec-packet.md',
  }),
  Object.freeze({
    key: 'kedar-transcendence-bridge',
    label: 'kedar bio-transcendence bridge',
    corpus: 'transcendence-stack',
    file: '/Users/mfaz/ai/kedar/docs/product/bio-transcendence-stack.md',
  }),
  Object.freeze({
    key: 'obsidian-post-sapiens',
    label: 'Obsidian post-sapiens',
    corpus: 'post-sapiens',
    root: '/Users/mfaz/ai/obsidian-vault/03 - Post-Sapiens',
  }),
  Object.freeze({
    key: 'obsidian-awakening',
    label: 'Obsidian awakening',
    corpus: 'awakening',
    root: '/Users/mfaz/ai/obsidian-vault/06 - Transcendence',
  }),
]);

export async function ingestMindContent(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const {
    records,
    sources,
    missingSources,
    excluded,
    failures,
  } = await mindContentExposureRecords({
    sources: options.sources ?? DEFAULT_MIND_CONTENT_SOURCES,
    logger: options.logger,
  });

  if (sources.length === 0) {
    return skippedResult(store, { missingSources, excluded, failures });
  }

  const result = await ingestWire(records, MIND_CONTENT_SURFACE, { ...options, store });
  return {
    ...result,
    skipped: false,
    consent: consentMetadata(),
    sourceCount: sources.length,
    missingSources,
    excluded,
    excludedCount: excluded.length,
    failures,
    failedCount: failures.length,
  };
}

export async function mindContentExposureRecords(options = {}) {
  const specs = normalizeMindContentSources(options.sources ?? DEFAULT_MIND_CONTENT_SOURCES);
  const logger = options.logger;
  const records = [];
  const sources = [];
  const missingSources = [];
  const excluded = [];
  const failures = [];

  for (const source of specs) {
    const sourceFiles = await approvedSourceFiles(source, { missingSources, failures, logger });
    if (sourceFiles.length === 0) continue;

    sources.push(source);
    for (const file of sourceFiles) {
      const relativePath = relativeSourcePath(source, file);
      if (blockedMindContentPath(relativePath) || blockedMindContentPath(file)) {
        excluded.push(excludedEntry(source, file, relativePath, 'founder-verdict-r4.3'));
        continue;
      }

      try {
        records.push(...await mindContentFileToExposures(file, { source, relativePath }));
      } catch (error) {
        const failure = failureEntry(source, file, relativePath, error);
        failures.push(failure);
        warn(logger, `ingest-mind-content: skipped ${failure.path}: ${failure.error}`);
      }
    }
  }

  records.sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) ||
    a.eventAt.localeCompare(b.eventAt));

  return {
    records,
    sources,
    missingSources,
    excluded,
    failures,
  };
}

export async function mindContentFileToExposures(file, { source, relativePath } = {}) {
  const spec = normalizeMindContentSource(source);
  const resolvedFile = safeExternalPath(file, 'mind-content file');
  const buffer = await fs.readFile(resolvedFile);
  if (isBinaryBuffer(buffer)) return [];

  const rawText = stripByteOrderMark(buffer.toString('utf8'));
  const text = normalizeDocumentText(stripMarkdownFrontmatter(rawText));
  if (!optionalString(text)) return [];

  const stat = await fs.stat(resolvedFile);
  const normalizedRelativePath = normalizeRelativePath(relativePath ?? relativeSourcePath(spec, resolvedFile));
  const contentHash = contentSha256(buffer);
  const title = noteLeadStatement(rawText) ?? path.basename(resolvedFile);
  const chunks = chunkMindContent(text);

  return chunks.map((chunk, index) => {
    const chunkNumber = index + 1;
    const chunkCount = chunks.length;
    const sourceId = [
      MIND_CONTENT_SURFACE,
      spec.key,
      normalizedRelativePath,
      contentHash,
      `chunk-${chunkNumber}-of-${chunkCount}`,
    ].join(':');

    return {
      type: 'reference',
      statement: chunk,
      sourceId,
      eventAt: stat.mtime.toISOString(),
      context: contextLabel({
        corpus: spec.corpus,
        relativePath: normalizedRelativePath,
        chunkNumber,
        chunkCount,
      }),
      provenance: { surface: MIND_CONTENT_SURFACE, lane: 'deliberate' },
      frontierExcluded: true,
      metadata: {
        canonicalMindContent: true,
        title,
        path: normalizedRelativePath,
        sourceKey: spec.key,
        sourceLabel: spec.label,
        corpus: spec.corpus,
        contentHash,
        byteLength: buffer.length,
        chunkIndex: index,
        chunkNumber,
        chunkCount,
        role: 'user',
        human: true,
        conversationId: conversationIdForDocChunk(spec, normalizedRelativePath, chunkNumber),
        conversationName: `${spec.corpus}: ${normalizedRelativePath}`,
        consent: consentMetadata(),
      },
    };
  });
}

export function chunkMindContent(text, maxChars = MIND_CONTENT_CHUNK_MAX_CHARS) {
  const source = optionalString(String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  if (!source) return [];
  if (source.length <= maxChars) return [source];

  const chunks = [];
  let rest = source;
  while (rest.length > maxChars) {
    const cut = chunkBoundary(rest, maxChars);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (optionalString(rest)) chunks.push(rest.trim());
  return chunks;
}

export function blockedMindContentPath(value) {
  const normalized = normalizeRelativePath(value);
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeMindContentSources(sources) {
  if (!Array.isArray(sources)) throw new Error('mind-content sources must be an array');
  return sources.map(normalizeMindContentSource);
}

function normalizeMindContentSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('mind-content source must be an object');
  }
  const key = normalizeSourceKey(source.key);
  const label = requiredString(source.label ?? key, 'mind-content source label');
  const corpus = requiredString(source.corpus, 'mind-content source corpus');
  if (!APPROVED_CORPORA.has(corpus)) {
    throw new Error(`unapproved mind-content corpus: ${corpus}`);
  }

  const root = optionalString(source.root);
  const file = optionalString(source.file);
  if (Boolean(root) === Boolean(file)) {
    throw new Error('mind-content source must specify exactly one of root or file');
  }

  return {
    key,
    label,
    corpus,
    ...(root ? { root: safeExternalPath(root, 'mind-content root') } : {}),
    ...(file ? { file: safeExternalPath(file, 'mind-content file') } : {}),
    maxDepth: Number.isInteger(source.maxDepth) ? source.maxDepth : 4,
  };
}

function normalizeSourceKey(value) {
  const key = requiredString(value, 'mind-content source key')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!key) throw new Error('mind-content source key is required');
  return key;
}

async function approvedSourceFiles(source, context) {
  const { missingSources, failures, logger } = context;

  if (source.file) {
    if (!await fileExists(source.file)) {
      missingSources.push(missingSource(source, source.file));
      return [];
    }
    if (!MARKDOWN_EXTENSIONS.includes(path.extname(source.file).toLowerCase())) return [];
    return [source.file];
  }

  if (!await directoryExists(source.root)) {
    missingSources.push(missingSource(source, source.root));
    return [];
  }

  try {
    return (await walkIngestDir(
      source.root,
      (file) => MARKDOWN_EXTENSIONS.includes(path.extname(file).toLowerCase()),
      { maxDepth: source.maxDepth },
    )).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const failure = failureEntry(source, source.root, '.', error);
    failures.push(failure);
    warn(logger, `ingest-mind-content: skipped source ${source.key}: ${failure.error}`);
    return [];
  }
}

function relativeSourcePath(source, file) {
  const root = source.root ?? path.dirname(source.file);
  return normalizeRelativePath(path.relative(root, file)) || path.basename(file);
}

function contextLabel({ corpus, relativePath, chunkNumber, chunkCount }) {
  const suffix = chunkCount > 1 ? ` [${chunkNumber}/${chunkCount}]` : '';
  return `${corpus}: ${relativePath}${suffix}`;
}

function conversationIdForDocChunk(source, relativePath, chunkNumber) {
  const hash = createHash('sha256')
    .update(`${source.key}\n${relativePath}\n${chunkNumber}`)
    .digest('hex')
    .slice(0, 16);
  return `${MIND_CONTENT_SURFACE}:${source.key}:${hash}`;
}

function chunkBoundary(text, maxChars) {
  const minimum = Math.floor(maxChars * 0.6);
  const window = text.slice(0, maxChars);
  for (const pattern of [/\n#{1,6}\s+[^\n]*$/g, /\n\n/g, /\n/g, /\s/g]) {
    let match;
    let boundary = -1;
    while ((match = pattern.exec(window)) !== null) {
      boundary = match.index + (pattern.source === '\\s' ? 1 : 0);
    }
    if (boundary >= minimum) return boundary;
  }
  return maxChars;
}

function excludedEntry(source, file, relativePath, reason) {
  return {
    sourceKey: source.key,
    corpus: source.corpus,
    path: normalizeRelativePath(relativePath ?? file),
    reason,
  };
}

function failureEntry(source, file, relativePath, error) {
  return {
    sourceKey: source.key,
    corpus: source.corpus,
    path: normalizeRelativePath(relativePath ?? file),
    error: errorMessage(error),
  };
}

function missingSource(source, location) {
  return {
    sourceKey: source.key,
    corpus: source.corpus,
    path: normalizeRelativePath(location),
  };
}

function skippedResult(store, { missingSources, excluded, failures }) {
  return {
    store,
    skipped: true,
    reason: 'no-approved-corpus-sources',
    message: MIND_CONTENT_NO_SOURCE_MESSAGE,
    surface: MIND_CONTENT_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
    consent: consentMetadata(),
    sourceCount: 0,
    missingSources,
    excluded,
    excludedCount: excluded.length,
    failures,
    failedCount: failures.length,
  };
}

function consentMetadata() {
  return {
    ...MIND_CONTENT_CONSENT,
    approvedCorpus: [...MIND_CONTENT_CONSENT.approvedCorpus],
    excludedCorpus: [...MIND_CONTENT_CONSENT.excludedCorpus],
  };
}

function normalizeDocumentText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function stripMarkdownFrontmatter(value) {
  const source = String(value ?? '');
  if (!source.startsWith('---')) return source;

  const match = source.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return match ? source.slice(match[0].length) : source;
}

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

function isBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  const sampleLength = Math.min(buffer.length, 4096);
  let controlCount = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    const allowedWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !allowedWhitespace) controlCount += 1;
  }
  return controlCount / sampleLength > 0.1;
}

function contentSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeRelativePath(value) {
  return optionalString(String(value ?? '').split(path.sep).join('/')) ?? '';
}

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeExternalPath(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const rel = path.relative('/', resolved);
  if (!rel) throw new Error(`refused unsafe data path: ${value}`);
  return safeDataPath('/', rel);
}

function errorMessage(error) {
  return optionalString(error?.message) ?? String(error);
}

function warn(logger, message) {
  if (logger?.warn) logger.warn(`[cs-k] ${message}`);
}
