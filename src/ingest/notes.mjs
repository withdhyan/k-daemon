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

export const NOTES_SURFACE = 'holon-notes';
export const NOTE_STATEMENT_MAX_CHARS = 280;
export const NOTES_EXPORT_DIR = safeDataPath(
  '/',
  path.join('ai', 'context dump', 'notes-export'),
);
export const NOTES_NO_EXPORT_MESSAGE =
  `ingest-notes: no notes export found at ${NOTES_EXPORT_DIR} - pass a directory or create /ai/context dump/notes-export`;

const NOTE_EXTENSIONS = Object.freeze(['.txt', '.md']);

export async function ingestNotes(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const dir = safeExternalPath(options.dir ?? options.path ?? NOTES_EXPORT_DIR, 'notes directory');

  if (!await directoryExists(dir)) {
    return skippedResult(store, { dir });
  }

  const records = await notesExposureRecordsFromDir(dir);
  const result = await ingestWire(records, NOTES_SURFACE, { ...options, store });
  return {
    ...result,
    dir,
    skipped: false,
  };
}

export async function notesExposureRecordsFromDir(dir) {
  const root = safeExternalPath(dir, 'notes directory');
  const files = (await walkIngestDir(
    root,
    (file) => NOTE_EXTENSIONS.includes(path.extname(file).toLowerCase()),
  )).sort((a, b) => a.localeCompare(b));
  const records = [];

  for (const file of files) {
    const record = await noteFileToExposure(file, { root });
    if (record) records.push(record);
  }

  return records;
}

export async function noteFileToExposure(file, { root = path.dirname(file) } = {}) {
  const resolvedFile = safeExternalPath(file, 'note file');
  const buffer = await fs.readFile(resolvedFile);
  if (isBinaryBuffer(buffer)) return null;

  const text = stripByteOrderMark(buffer.toString('utf8'));
  const statement = noteLeadStatement(text);
  if (!statement) return null;

  const stat = await fs.stat(resolvedFile);
  const relativePath = normalizeRelativePath(path.relative(root, resolvedFile)) ||
    path.basename(resolvedFile);
  const contentHash = contentSha256(buffer);

  return {
    type: 'reference',
    statement,
    sourceId: [
      NOTES_SURFACE,
      relativePath,
      contentHash,
    ].join(':'),
    eventAt: stat.mtime.toISOString(),
    context: path.basename(resolvedFile),
    provenance: { surface: NOTES_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      path: relativePath,
      contentHash,
      byteLength: buffer.length,
    },
  };
}

export function noteLeadStatement(text, maxChars = NOTE_STATEMENT_MAX_CHARS) {
  const source = stripMarkdownFrontmatter(stripByteOrderMark(String(text ?? '')));
  for (const line of source.split(/\r?\n/)) {
    const lead = markdownLeadLine(line);
    if (lead) return boundStatement(lead, maxChars);
  }
  return undefined;
}

export function boundStatement(value, maxChars = NOTE_STATEMENT_MAX_CHARS) {
  const text = optionalString(String(value ?? '').replace(/\s+/g, ' '));
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function markdownLeadLine(line) {
  const text = optionalString(
    String(line ?? '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s+/, ''),
  );
  if (!text || text === '---') return undefined;
  return text;
}

function stripMarkdownFrontmatter(value) {
  const source = String(value ?? '');
  if (!source.startsWith('---')) return source;

  const match = source.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return match ? source.slice(match[0].length) : source;
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

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

function normalizeRelativePath(value) {
  return optionalString(String(value ?? '').split(path.sep).join('/'));
}

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
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

function skippedResult(store, { dir }) {
  return {
    store,
    dir,
    skipped: true,
    message: NOTES_NO_EXPORT_MESSAGE,
    surface: NOTES_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
}
